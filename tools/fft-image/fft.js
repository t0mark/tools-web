/*
 * 2D FFT (radix-2, in-place). 크기는 2의 거듭제곱 정사각형(N×N)만 지원.
 */
(function (global) {
  'use strict';

  const cache = new Map();

  function plan(n) {
    if (cache.has(n)) return cache.get(n);
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    const p = { n, rev, cos, sin };
    cache.set(n, p);
    return p;
  }

  // 1D FFT. inverse=true면 역변환(1/n 스케일 포함 안 함)
  function fft1d(re, im, p, inverse) {
    const { n, rev, cos, sin } = p;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const wr = cos[k];
          const wi = sgn * sin[k];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  // 2D FFT (in-place). 역변환은 1/(n*n) 스케일까지 적용
  function fft2d(re, im, n, inverse) {
    const p = plan(n);
    for (let y = 0; y < n; y++) {
      fft1d(re.subarray(y * n, y * n + n), im.subarray(y * n, y * n + n), p, inverse);
    }
    const cr = new Float64Array(n);
    const ci = new Float64Array(n);
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) { cr[y] = re[y * n + x]; ci[y] = im[y * n + x]; }
      fft1d(cr, ci, p, inverse);
      for (let y = 0; y < n; y++) { re[y * n + x] = cr[y]; im[y * n + x] = ci[y]; }
    }
    if (inverse) {
      const s = 1 / (n * n);
      for (let i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  global.FFT = { fft2d };
})(self);
