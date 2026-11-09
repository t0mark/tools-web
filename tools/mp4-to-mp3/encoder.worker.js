/*
 * MP3 인코딩 워커 (스트리밍)
 * - init  : { sampleRate, channels, kbps }        → LAME 인코더 생성
 * - chunk : { id, pcm: Int16Array[] (채널별) }      → 인코딩 후 { type:'ack', id }
 * - end   :                                         → flush 후 { type:'done', blob }
 * 구간 단위로 받아서 바로 인코딩하므로 긴 영상도 메모리를 적게 사용한다.
 */
/* global lamejs */
importScripts('../../vendor/lamejs/lame.min.js');

const BLOCK = 1152 * 32; // MPEG 프레임(1152샘플) 여러 개씩 묶어서 넘김
let encoder = null;
let parts = [];

function push(out) {
  if (out.length > 0) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      encoder = new lamejs.Mp3Encoder(msg.channels, msg.sampleRate, msg.kbps);
      parts = [];
    } else if (msg.type === 'chunk') {
      const [left, right] = msg.pcm;
      for (let i = 0; i < left.length; i += BLOCK) {
        const end = Math.min(i + BLOCK, left.length);
        push(right
          ? encoder.encodeBuffer(left.subarray(i, end), right.subarray(i, end))
          : encoder.encodeBuffer(left.subarray(i, end)));
      }
      self.postMessage({ type: 'ack', id: msg.id });
    } else if (msg.type === 'end') {
      push(encoder.flush());
      const blob = new Blob(parts, { type: 'audio/mpeg' });
      parts = [];
      encoder = null;
      self.postMessage({ type: 'done', blob });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
