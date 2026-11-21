/*
  Interleaved real/imag Float64Array representation: [re0, im0, re1, im1, ...].
*/

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* In-place FFT (inverse=false) or IFFT (inverse=true). `data` length must be 2*N with N a power of two. */
export function fft(data: Float64Array, inverse = false): void {
  const n = data.length >> 1;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`fft: length ${n} is not a power of two`);
  }

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const ri = i * 2,
        rj = j * 2;
      let t = data[ri];
      data[ri] = data[rj];
      data[rj] = t;
      t = data[ri + 1];
      data[ri + 1] = data[rj + 1];
      data[rj + 1] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angStep = (sign * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < halfLen; k++) {
        const ang = angStep * k;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        const evenIdx = (i + k) * 2;
        const oddIdx = (i + k + halfLen) * 2;
        const oRe = data[oddIdx],
          oIm = data[oddIdx + 1];
        const tRe = oRe * wRe - oIm * wIm;
        const tIm = oRe * wIm + oIm * wRe;
        const eRe = data[evenIdx],
          eIm = data[evenIdx + 1];
        data[evenIdx] = eRe + tRe;
        data[evenIdx + 1] = eIm + tIm;
        data[oddIdx] = eRe - tRe;
        data[oddIdx + 1] = eIm - tIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < data.length; i++) data[i] /= n;
  }
}

/** Frequency-domain correlation-based matched filter: out = IFFT( FFT(signal) * conj(FFT(ref)) ). */
export function matchedFilterCorrelate(
  signal: Float64Array,
  ref: Float64Array,
  fftLen: number,
): Float64Array {
  const a = new Float64Array(fftLen * 2);
  const b = new Float64Array(fftLen * 2);
  a.set(signal.subarray(0, Math.min(signal.length, fftLen * 2)));
  b.set(ref.subarray(0, Math.min(ref.length, fftLen * 2)));

  fft(a, false);
  fft(b, false);

  const out = new Float64Array(fftLen * 2);
  for (let i = 0; i < fftLen; i++) {
    const aRe = a[i * 2],
      aIm = a[i * 2 + 1];
    const bRe = b[i * 2],
      bIm = -b[i * 2 + 1]; // conjugate of ref spectrum
    out[i * 2] = aRe * bRe - aIm * bIm;
    out[i * 2 + 1] = aRe * bIm + aIm * bRe;
  }
  fft(out, true);
  return out;
}
