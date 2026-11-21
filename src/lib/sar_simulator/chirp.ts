import { fft, matchedFilterCorrelate, nextPow2 } from "./fft";
import { SPEED_OF_LIGHT } from "./types";

export interface ChirpConfig {
  bandwidth_Hz: number;
  pulseDuration_s: number;
  sampleRate_Hz: number;
}

export function deriveFastTimeConfig(bandwidth: number, oversample = 1.2) {
  const sampleRate = bandwidth * oversample;
  const rangeBinSize = SPEED_OF_LIGHT / (2 * sampleRate);
  const slantRangeResolution = SPEED_OF_LIGHT / (2 * bandwidth);
  return { sampleRate, rangeBinSize, slantRangeResolution };
}

export function generateChirp(chirpConfig: ChirpConfig): Float64Array {
  const nSamples = Math.max(
    4,
    Math.round(chirpConfig.pulseDuration_s * chirpConfig.sampleRate_Hz),
  );

  const K = chirpConfig.bandwidth_Hz / chirpConfig.pulseDuration_s;
  const out = new Float64Array(nSamples * 2);
  const dt = 1 / chirpConfig.sampleRate_Hz;
  const t0 = -chirpConfig.pulseDuration_s / 2;
  for (let i = 0; i < nSamples; i++) {
    const t = t0 + i * dt;
    const phase = Math.PI * K * t * t;
    out[i * 2] = Math.cos(phase);
    out[i * 2 + 1] = Math.sin(phase);
  }
  return out;
}

export function rangeCompressPulse(
  pulse: Float64Array,
  refChirp: Float64Array,
  numRangeSamples: number,
): Float64Array {
  const fftLen = nextPow2(numRangeSamples + refChirp.length / 2);
  const compressed = matchedFilterCorrelate(pulse, refChirp, fftLen);

  const chirpHalfLen = Math.floor(refChirp.length / 4);
  const out = new Float64Array(numRangeSamples * 2);
  for (let i = 0; i < numRangeSamples; i++) {
    const srcIdx = (((i + chirpHalfLen) % fftLen) + fftLen) % fftLen;
    out[i * 2] = compressed[srcIdx * 2];
    out[i * 2 + 1] = compressed[srcIdx * 2 + 1];
  }

  return out;
}
