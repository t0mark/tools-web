/*
 * MP3 인코딩 워커
 * - 메인 스레드에서 16-bit PCM(Int16Array, 채널별)을 받아 lamejs(LAME)로 CBR MP3 인코딩
 * - UI가 멈추지 않도록 별도 스레드에서 실행
 */
/* global lamejs */
importScripts('../../vendor/lamejs/lame.min.js');

// MPEG 프레임당 1152 샘플. 여러 프레임을 묶어서 넘겨야 빠름.
const BLOCK = 1152 * 32;

self.onmessage = (e) => {
  const { channels, sampleRate, kbps } = e.data;
  try {
    const numCh = channels.length;
    const left = channels[0];
    const right = numCh > 1 ? channels[1] : null;
    const total = left.length;

    const encoder = new lamejs.Mp3Encoder(numCh, sampleRate, kbps);
    const parts = [];
    let lastReport = 0;

    for (let i = 0; i < total; i += BLOCK) {
      const end = Math.min(i + BLOCK, total);
      const l = left.subarray(i, end);
      const out = right ? encoder.encodeBuffer(l, right.subarray(i, end)) : encoder.encodeBuffer(l);
      if (out.length > 0) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());

      const now = Date.now();
      if (now - lastReport > 100) {
        lastReport = now;
        self.postMessage({ type: 'progress', value: end / total });
      }
    }

    const tail = encoder.flush();
    if (tail.length > 0) parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());

    const blob = new Blob(parts, { type: 'audio/mpeg' });
    self.postMessage({ type: 'done', blob });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
