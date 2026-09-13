import * as THREE from "three";
import {
  cos,
  distance,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  Loop,
  select,
  sin,
  sqrt,
  storage,
  uniform,
} from "three/tsl";
import { StorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import {
  type SimSettings,
  type FastTimeSetup,
  computeImageLayout,
  hannWindow,
  magnitudesToImage,
} from "./processing";
import type { SarPassGeometryData, SarImage, Scatterer } from "./types";

const KERNEL_A = 2;

let sharedRenderer: InstanceType<typeof WebGPURenderer> | null = null;
let rendererPromise: Promise<InstanceType<typeof WebGPURenderer>> | null = null;

export function getSharedWebGPURenderer(): Promise<
  InstanceType<typeof WebGPURenderer>
> {
  if (sharedRenderer) return Promise.resolve(sharedRenderer);
  if (rendererPromise) return rendererPromise;

  rendererPromise = (async () => {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? (new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement)
        : undefined;

    const renderer = new WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    sharedRenderer = renderer;
    return renderer;
  })();

  return rendererPromise;
}

export async function isGpuSupported(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export async function backProjectImage(
  params: SimSettings,
  geometry: SarPassGeometryData,
  compressed: Float32Array,
  setup: FastTimeSetup,
): Promise<SarImage> {
  const renderer = await getSharedWebGPURenderer();

  const layout = computeImageLayout(params, geometry, setup);
  const { width, height, dGr, dAz } = layout;
  const numPulses = geometry.samples.length;
  const { numRangeBins, rangeMin, rangeBinSize } = setup;
  const wavelength = geometry.wavelength_m;

  const platformPositions = new Float32Array(numPulses * 3);
  for (let p = 0; p < numPulses; p++) {
    const s = geometry.samples[p].position;
    platformPositions[p * 3 + 0] = s.x;
    platformPositions[p * 3 + 1] = s.y;
    platformPositions[p * 3 + 2] = s.z;
  }
  const windowValues = hannWindow(numPulses);
  const output = new Float32Array(width * height);

  const compressedAttribute = new StorageBufferAttribute(compressed, 2);
  const platformAttribute = new StorageBufferAttribute(platformPositions, 2);
  const windowAttribute = new StorageBufferAttribute(windowValues, 2);
  const outputAttribute = new StorageBufferAttribute(output, 2);

  const compressedBuffer = storage(
    compressedAttribute,
    "vec2",
    numPulses * numRangeBins,
  );
  const platformBuffer = storage(platformAttribute, "vec3", numPulses);
  const windowBuffer = storage(windowAttribute, "float", numPulses);
  const outputBuffer = storage(outputAttribute, "float", width * height);

  const uWidth = uniform(width, "uint");
  const uDGr = uniform(dGr, "float");
  const uDAz = uniform(dAz, "float");
  const uHalfHeightMinus1 = uniform((height - 1) / 2, "float");
  const uHalfWidthMinus1 = uniform((width - 1) / 2, "float");
  const uCenter = uniform(geometry.sceneCenter.clone());
  const uGroundAxis = uniform(geometry.groundRangeAxis.clone());
  const uAzAxis = uniform(geometry.azimuthAxis.clone());
  const uRangeMin = uniform(rangeMin, "float");
  const uRangeBinSize = uniform(rangeBinSize, "float");
  const uNumRangeBins = uniform(numRangeBins, "int");
  const uWavelength = uniform(wavelength, "float");

  // 'x' is (idxFloat - sampleIdx)
  const lanczosWeight = Fn(([x]: [any]) => {
    const isZero = x.abs().lessThan(1e-6);
    const piX = x.mul(Math.PI);
    const raw = float(KERNEL_A)
      .mul(sin(piX))
      .mul(sin(piX.div(KERNEL_A)))
      .div(piX.mul(piX));
    return select(isZero, float(1), raw);
  });

  const backprojectKernel = Fn(() => {
    const idx = instanceIndex;
    const row = int(idx).div(int(uWidth));
    const col = int(idx).mod(int(uWidth));

    const gr = float(row).sub(uHalfHeightMinus1).mul(uDGr);
    const az = float(row).sub(uHalfHeightMinus1).mul(uDAz);

    const pixelPos = uCenter.add(uGroundAxis.mul(gr)).add(uAzAxis.mul(az));

    const accRe = float(0).toVar();
    const accIm = float(0).toVar();

    Loop(numPulses, ({ i }) => {
      const pulseIndex = int(i);
      const platformPos = platformBuffer.element(pulseIndex);
      const R = distance(platformPos, pixelPos);
      const idxFloat = R.sub(uRangeMin).div(uRangeBinSize);
      const base = int(floor(idxFloat));

      const inBounds = base
        .sub(KERNEL_A - 1)
        .greaterThanEqual(int(0))
        .and(base.add(KERNEL_A).lessThan(uNumRangeBins));

      If(inBounds, () => {
        const sumRe = float(0).toVar();
        const sumIm = float(0).toVar();

        for (let k = -(KERNEL_A - 1); k <= KERNEL_A; k++) {
          const sampleIdx = base.add(int(k));
          const x = idxFloat.sub(float(sampleIdx));
          const w = lanczosWeight(x);

          const flatIdx = pulseIndex.mul(uNumRangeBins).add(sampleIdx);
          const val = compressedBuffer.element(flatIdx);
          sumRe.addAssign(w.mul(val.x));
          sumIm.addAssign(w.mul(val.y));
        }

        const phase = R.mul(4 * Math.PI).div(uWavelength);
        const cA = cos(phase);
        const sA = sin(phase);
        const window = windowBuffer.element(pulseIndex);

        accRe.addAssign(window.mul(sumRe.mul(cA).sub(sumIm.mul(sA))));
        accIm.addAssign(window.mul(sumRe.mul(sA).sub(sumIm.mul(cA))));
      });
    });

    const magnitude = sqrt(accRe.mul(accRe).add(accIm.mul(accIm)));
    outputBuffer.element(idx).assign(magnitude);
  });

  const computeNode = backprojectKernel().compute(width * height);

  await renderer.computeAsync(computeNode);

  const resultBuffer = await (renderer as any).getArrayBufferAsync(
    outputAttribute,
  );
  const magnitudes = new Float32Array(resultBuffer);
  return magnitudesToImage(magnitudes, layout);
}

export async function runSarProcessing(
  params: SimSettings,
  geometry: SarPassGeometryData,
  scatterers: Scatterer[],
): Promise<SarImage> {
  const { synthesiseRangeCompressed, runSarProcessing } =
    await import("./processing");

  const { data, setup } = synthesiseRangeCompressed(
    params,
    geometry,
    scatterers,
  );

  const supported = await isGpuSupported();
  if (!supported) {
    return runSarProcessing(params, geometry, scatterers);
  }

  try {
    return await backProjectImage(params, geometry, data, setup);
  } catch (err) {
    console.warn("GPU backprojection failed, falling back CPU:", err);
    return runSarProcessing(params, geometry, scatterers);
  }
}
