import * as THREE from "three";
import {
  SPEED_OF_LIGHT,
  type PolarizationConfig,
  type SarImage,
  type SarParams,
  type SarPassGeometryData,
  type SarStats,
  type Scatterer,
} from "./types";
import { deriveFastTimeConfig } from "./chirp";

const RANGE_INTERP_TAPS_A = 2;
const UP = new THREE.Vector3(0, 1, 0);

function sinc(x: number): number {
  return Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
}

function lanczosKernel(x: number, a: number) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const piX = Math.PI * x;
  return (a * Math.sin(piX) * Math.sin(piX / a)) / (piX * piX);
}

function sampleRangeCompressedLanczos(
  compressed: Float32Array,
  pulseIndex: number,
  numRangeBins: number,
  idxFloat: number,
  a: number = RANGE_INTERP_TAPS_A,
): { re: number; im: number } | null {
  const base = Math.floor(idxFloat);
  const lo = base - a + 1;
  const hi = base + a;
  if (lo < 0 || hi >= numRangeBins) return null;

  let re = 0;
  let im = 0;
  const rowOffset = pulseIndex * numRangeBins;
  for (let k = lo; k <= hi; k++) {
    const w = lanczosKernel(idxFloat - k, a);
    if (w === 0) continue;
    const idx = (rowOffset + k) * 2;
    re += w * compressed[idx];
    im += w * compressed[idx + 1];
  }
  return { re, im };
}

export interface SimSettings extends SarParams {
  maxScatterersUsed?: number;
}

export interface FastTimeSetup {
  sampleRate: number;
  rangeBinSize: number;
  slantRangeResolution: number;
  rangeMin: number;
  rangeMax: number;
  numRangeBins: number;
}

function computeRangeWindow(
  geometry: SarPassGeometryData,
  scatterers: Scatterer[],
  rangeBinSize: number,
  kernelHalfWidthSamples: number,
): { rangeMin: number; rangeMax: number } {
  let rho = 0;

  for (const s of scatterers) {
    const d = geometry.sceneCenter.distanceTo(s.position);
    if (d > rho) rho = d;
  }

  const R0 = geometry.slantRangeToCenter;
  let rangeMin = Math.max(0, R0 - rho);
  let rangeMax = R0 + rho;

  if (scatterers.length === 0) {
    rangeMin = R0 * 0.5;
    rangeMax = R0 * 1.5;
  }

  const margin = Math.max(
    5 * rangeBinSize * kernelHalfWidthSamples,
    0.02 * geometry.slantRangeToCenter,
  );

  return { rangeMin: rangeMin - margin, rangeMax: rangeMax + margin };
}

function antennaGain(angle_rad: number, beamwidth_rad: number): number {
  const x = (Math.PI * angle_rad) / beamwidth_rad;
  const g = sinc(x);
  return g * g;
}

function polarizationFactor(
  polarizationConfig: PolarizationConfig,
  normal: THREE.Vector3,
): number {
  const tilt = 1 - Math.abs(normal.dot(UP));
  if (polarizationConfig.tx === polarizationConfig.rx) {
    return 0.6 + 0.4 * (1 - tilt);
  }

  return 0.05 + 0.35 * tilt;
}

export function synthesiseRangeCompressed(
  params: SimSettings,
  geometry: SarPassGeometryData,
  scatterers: Scatterer[],
): { data: Float32Array; setup: FastTimeSetup } {
  const oversample = params.rangeOversample ?? 1.2;
  const { sampleRate, rangeBinSize, slantRangeResolution } =
    deriveFastTimeConfig(params.chirpBandwidth_Hz, oversample);

  const kernelHalfWidth = 6;
  const { rangeMin, rangeMax } = computeRangeWindow(
    geometry,
    scatterers,
    rangeBinSize,
    kernelHalfWidth,
  );

  const MAX_RANGE_BINS = 65536;
  const numRangeBins = Math.min(
    MAX_RANGE_BINS,
    Math.max(
      32,
      Math.ceil((rangeMax - rangeMin) / rangeBinSize) + 2 * kernelHalfWidth,
    ),
  );

  const numPulses = geometry.samples.length;
  const data = new Float32Array(numPulses * numRangeBins * 2);

  const wavelength = geometry.wavelength_m;
  const beamwidth_rad = Math.max(
    1e-4,
    wavelength / Math.max(params.antennaSize_m, 1e-3),
  );
  const gainCutoff_rad = 3 * beamwidth_rad;

  const viewDir = new THREE.Vector3();
  const boresight = new THREE.Vector3();

  for (let p = 0; p < numPulses; p++) {
    const platform = geometry.samples[p];
    boresight.copy(platform.boresight);
    const lineOffset = p * numRangeBins * 2;

    for (let si = 0; si < scatterers.length; si++) {
      const scatterer = scatterers[si];
      viewDir.copy(scatterer.position).sub(platform.position);
      const R = viewDir.length();
      if (R < 1e-6) continue;
      viewDir.multiplyScalar(1 / R);

      const cosAngle = THREE.MathUtils.clamp(boresight.dot(viewDir), -1, 1);
      const angle = Math.acos(cosAngle);
      if (angle > gainCutoff_rad) continue;

      const gain = antennaGain(angle, beamwidth_rad);
      if (gain < 1e-4) continue;

      const viewFactor = Math.max(-scatterer.normal.dot(viewDir), 0) + 0.05;

      const polFactor = polarizationFactor(
        params.polarization,
        scatterer.normal,
      );

      const amplitude =
        (scatterer.albedo * viewFactor * gain * polFactor) / (R * R + 1);

      const carrierPhase = (-4 * Math.PI * R) / wavelength;
      const cA = Math.cos(carrierPhase);
      const sA = Math.sin(carrierPhase);

      const idxFloat = (R - rangeMin) / rangeBinSize;
      const idx0 = Math.floor(idxFloat);
      if (idx0 - kernelHalfWidth < 0 || idx0 + kernelHalfWidth >= numRangeBins)
        continue;

      for (let k = -kernelHalfWidth; k <= kernelHalfWidth; k++) {
        const sampleIdx = idx0 + k;
        const sampleOffsetSamples = sampleIdx - idxFloat;
        const twoWayTimeOffset =
          (sampleOffsetSamples * (2 * rangeBinSize)) / SPEED_OF_LIGHT;
        const env = sinc(Math.PI * params.chirpBandwidth_Hz * twoWayTimeOffset);
        const a = amplitude * env;
        const base = lineOffset + sampleIdx * 2;
        data[base] += a * cA;
        data[base + 1] += a * sA;
      }
    }
  }

  return {
    data,
    setup: {
      sampleRate,
      rangeBinSize,
      slantRangeResolution,
      rangeMin,
      rangeMax,
      numRangeBins,
    },
  };
}

function hann(i: number, n: number): number {
  if (n <= 1) return 1;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
}

export function hannWindow(numPulses: number) {
  const w = new Float32Array(numPulses);
  for (let p = 0; p < numPulses; p++) w[p] = hann(p, numPulses);
  return w;
}

export interface ImageLayout {
  width: number;
  height: number;
  dGr: number;
  dAz: number;
  groundRangeExtent_m: number;
  azimuthExtent_m: number;
  stats: SarStats;
}

export function computeImageLayout(
  params: SimSettings,
  geometry: SarPassGeometryData,
  setup: FastTimeSetup,
): ImageLayout {
  const wavelength = geometry.wavelength_m;

  const beamwidth_rad = Math.max(
    1e-4,
    wavelength / Math.max(params.antennaSize_m, 1e-3),
  );
  const groundRangeExtent_m = Math.max(
    10,
    Math.min(
      (setup.rangeMax - setup.rangeMin) /
        Math.max(Math.sin(geometry.incidenceAngle_rad), 0.05),
      geometry.slantRangeToCenter,
    ),
  );
  const footprintFromBeam =
    2 *
    geometry.slantRangeToCenter *
    Math.tan(beamwidth_rad / 2) *
    (params.mode === "spotlight" ? 1.5 : 3);

  const azimuthExtent_m = Math.max(
    10,
    Math.min(footprintFromBeam, geometry.slantRangeToCenter),
  );

  const groundRangeResolution_m =
    setup.slantRangeResolution /
    Math.max(Math.sin(geometry.incidenceAngle_rad), 0.05);

  const syntheticApertureLength_m =
    params.platformSpeed_mps * params.apertureDuration_s;
  const azimuthResolution_m =
    params.mode === "spotlight"
      ? (wavelength * geometry.slantRangeToCenter) /
        Math.max(2 * syntheticApertureLength_m, 1e-3)
      : params.antennaSize_m / 2.0;

  const maxImageDim = params.imageSize ?? 512;
  const minImageDim = 512;

  const height = Math.min(
    Math.max(
      Math.round(groundRangeExtent_m / Math.max(groundRangeResolution_m, 1e-6)),
      minImageDim,
    ),
    maxImageDim,
  );
  const width = Math.min(
    Math.max(
      Math.round(azimuthExtent_m / Math.max(azimuthResolution_m, 1e-6)),
      minImageDim,
    ),
    maxImageDim,
  );

  const dGr = groundRangeExtent_m / height;
  const dAz = azimuthExtent_m / width;

  const stats: SarStats = {
    rangeResolution_m: groundRangeResolution_m,
    azimuthResolution_m,
    slantRange_m: geometry.slantRangeToCenter,
    azimuthAngle_rad: geometry.azimuthAngle_rad,
    lookAngle_rad: geometry.incidenceAngle_rad,
    syntheticAperture_m: syntheticApertureLength_m,
  };

  return {
    width,
    height,
    dGr,
    dAz,
    groundRangeExtent_m,
    azimuthExtent_m,
    stats,
  };
}

export function magnitudesToImage(
  magnitudes: Float32Array,
  layout: ImageLayout,
): SarImage {
  const { width, height } = layout;

  let maxMag = 1e-123;
  for (let i = 0; i < magnitudes.length; i++) {
    if (magnitudes[i] > maxMag) maxMag = magnitudes[i];
  }

  const db = new Float32Array(width * height);
  let min_dB = Infinity;
  let max_dB = -Infinity;
  const floor_dB = -40;
  for (let i = 0; i < magnitudes.length; i++) {
    let v = 20 * Math.log10((magnitudes[i] + 1e-12) / maxMag);
    if (v < floor_dB) v = floor_dB;
    db[i] = v;
    if (v < min_dB) min_dB = v;
    if (v > max_dB) max_dB = v;
  }

  return {
    width,
    height,
    data: db,
    groundRangeExtent_m: layout.groundRangeExtent_m,
    azimuthExtent_m: layout.azimuthExtent_m,
    min_dB,
    max_dB,
    stats: layout.stats,
  };
}

function backProjectImage(
  params: SimSettings,
  geometry: SarPassGeometryData,
  compressed: Float32Array,
  setup: FastTimeSetup,
): SarImage {
  const numPulses = geometry.samples.length;
  const wavelength = geometry.wavelength_m;
  const layout = computeImageLayout(params, geometry, setup);
  const { width, height, dGr, dAz } = layout;

  const magnitudes = new Float32Array(width * height);

  //const pixelPos = new THREE.Vector3();
  const groundAxis = geometry.groundRangeAxis;
  const azAxis = geometry.azimuthAxis;
  const center = geometry.sceneCenter;

  const window = hannWindow(numPulses);

  for (let row = 0; row < height; row++) {
    const gr = (row - (height - 1) / 2) * dGr;
    for (let col = 0; col < width; col++) {
      const az = (col - (width - 1) / 2) * dAz;

      //pixelPos
      //  .copy(center)
      //  .addScaledVector(groundAxis, gr)
      //  .addScaledVector(azAxis, az);

      const px = center.x + groundAxis.x * gr + azAxis.x * az;
      const py = center.y + groundAxis.y * gr + azAxis.y * az;
      const pz = center.z + groundAxis.z * gr + azAxis.z * az;

      let accRe = 0;
      let accIm = 0;

      for (let p = 0; p < numPulses; p++) {
        const platform = geometry.samples[p];
        const dx = platform.position.x - px;
        const dy = platform.position.y - py;
        const dz = platform.position.z - pz;
        const R = Math.sqrt(dx * dx + dy * dy + dz * dz);
        //const R = platform.position.distanceTo(pixelPos);

        const idxFloat = (R - setup.rangeMin) / setup.rangeBinSize;
        //const sample = sampleRangeCompressedLanczos(
        //  compressed,
        //  p,
        //  setup.numRangeBins,
        //  idxFloat,
        //);
        //if (!sample) continue;
        //const { re, im } = sample;
        const idx0 = Math.floor(idxFloat);
        if (idx0 < 0 || idx0 + 1 >= setup.numRangeBins) continue;
        const frac = idxFloat - idx0;

        const base0 = (p * setup.numRangeBins + idx0) * 2;
        const base1 = base0 + 2;
        const re = compressed[base0] * (1 - frac) + compressed[base1] * frac;
        const im =
          compressed[base0 + 1] * (1 - frac) + compressed[base1 + 1] * frac;

        const phase = (4 * Math.PI * R) / wavelength;
        const cA = Math.cos(phase);
        const sA = Math.sin(phase);
        const w = window[p];

        accRe += w * (re * cA - im * sA);
        accIm += w * (re * sA + im * cA);
      }
      magnitudes[row * width + col] = Math.sqrt(accRe * accRe + accIm * accIm);
    }
  }

  return magnitudesToImage(magnitudes, layout);
}

export function runSarProcessing(
  params: SimSettings,
  geometry: SarPassGeometryData,
  scatterers: Scatterer[],
): SarImage {
  const { data, setup } = synthesiseRangeCompressed(
    params,
    geometry,
    scatterers,
  );
  return backProjectImage(params, geometry, data, setup);
}
