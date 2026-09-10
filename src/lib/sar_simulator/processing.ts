import * as THREE from "three";
import {
  SPEED_OF_LIGHT,
  type Polarization,
  type PolarizationConfig,
  type SarImage,
  type SarParams,
  type SarPassGeometryData,
  type Scatterer,
} from "./types";
import { deriveFastTimeConfig } from "./chirp";

const UP = new THREE.Vector3(0, 1, 0);

function sinc(x: number): number {
  return Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
}

export interface SimSettings extends SarParams {
  maxScatterersUsed?: number;
}

interface FastTimeSetup {
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
  const midSample = geometry.samples[Math.floor(geometry.samples.length / 2)];
  let rangeMin = Infinity;
  let rangeMax = -Infinity;

  for (const s of scatterers) {
    const r = midSample.position.distanceTo(s.position);
    if (r < rangeMin) rangeMin = r;
    if (r > rangeMax) rangeMax = r;
  }

  if (!Number.isFinite(rangeMin)) {
    rangeMin = geometry.slantRangeToCenter * 0.5;
    rangeMax = geometry.slantRangeToCenter * 1.5;
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

  return 0.05 * 0.35 * tilt;
}

function synthesiseRangeCompressed(
  params: SimSettings,
  geometry: SarPassGeometryData,
  scatterers: Scatterer[],
): { data: Float64Array; setup: FastTimeSetup } {
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
  const numRangeBins = Math.max(
    32,
    Math.ceil((rangeMax - rangeMin) / rangeBinSize) + 2 * kernelHalfWidth,
  );

  const numPulses = geometry.samples.length;
  const data = new Float64Array(numPulses * numRangeBins * 2);

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
      const platform = geometry.samples[p];
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

      const toPlatform = viewDir.clone().negate();
      const viewFactor = Math.max(scatterer.normal.dot(toPlatform), 0) + 0.05;

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

function backProjectImage(
  params: SimSettings,
  geometry: SarPassGeometryData,
  compressed: Float64Array,
  setup: FastTimeSetup,
): SarImage {
  const imageSize = params.imageSize ?? 128;
  const numPulses = geometry.samples.length;
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

  const dGr = groundRangeExtent_m / imageSize;
  const dAz = azimuthExtent_m / imageSize;

  const magnitudes = new Float32Array(imageSize * imageSize);

  const pixelPos = new THREE.Vector3();
  const groundAxis = geometry.groundRangeAxis;
  const azAxis = geometry.azimuthAxis;
  const center = geometry.sceneCenter;

  const window = new Float64Array();
  for (let p = 0; p < numPulses; p++) {
    window[p] = hann(p, numPulses);
  }

  for (let row = 0; row < imageSize; row++) {
    const az = (row - (imageSize - 1) / 2) * dAz;
    for (let col = 0; col < imageSize; col++) {
      const gr = (col - (imageSize - 1) / 2) * dGr;

      pixelPos
        .copy(center)
        .addScaledVector(groundAxis, gr)
        .addScaledVector(azAxis, az);

      let accRe = 0;
      let accIm = 0;

      for (let p = 0; p < numPulses; p++) {
        const platform = geometry.samples[p];
        const R = platform.position.distanceTo(pixelPos);

        const idxFloat = (R - setup.rangeMin) / setup.rangeBinSize;
        const idx0 = Math.floor(idxFloat);
        if (idx0 < 0 || idx0 + 1 >= setup.numRangeBins) continue;
        const frac = idxFloat - idx0;

        const base0 = p * setup.numRangeBins * idx0 * 2;
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

        const magnitude = Math.sqrt(accRe * accRe + accIm * accIm);
        magnitudes[row * imageSize + col] = magnitude;
      }
    }
  }

  let maxMag = 1e-123;
  for (let i = 0; i < magnitudes.length; i++) {
    if (magnitudes[i] > maxMag) maxMag = magnitudes[i];
  }

  const db = new Float32Array(imageSize * imageSize);
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
    width: imageSize,
    height: imageSize,
    data: db,
    groundRangeExtent_m,
    azimuthExtent_m,
    min_dB,
    max_dB,
  };
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
