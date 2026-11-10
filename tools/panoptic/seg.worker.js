/*
 * 파놉틱 세그멘테이션 워커
 * 모델: onnx-community/maskformer-swin-tiny-coco (INT8, 약 48MB, COCO 파놉틱 133종)
 * transformers.js 가 모델을 받아 Cache Storage 에 저장하므로 두 번째부터는 다운로드 없음.
 */
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

const MODEL = 'onnx-community/maskformer-swin-tiny-coco';
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

const post = (m, t) => self.postMessage(m, t || []);
let segmenter = null;

async function load() {
  if (segmenter) return segmenter;
  const files = new Map();
  segmenter = await pipeline('image-segmentation', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: 'progress', loaded, total });
      }
    },
  });
  return segmenter;
}

self.onmessage = async (e) => {
  const { type, rgba, width, height } = e.data;
  if (type !== 'run') return;
  try {
    const t0 = performance.now();
    post({ type: 'stage', text: '모델 준비 중…' });
    const seg = await load();
    const t1 = performance.now();
    post({ type: 'stage', text: '분석 중…' });
    const image = new RawImage(rgba, width, height, 4);
    // 이 모델의 기본 출력이 파놉틱 (지정 시 transformers.js 4.3.2 에서 오류가 나서 기본값 사용)
    const out = await seg(image);
    const t2 = performance.now();
    const segments = [];
    const transfer = [];
    for (const s of out) {
      const d = s.mask.data;
      const m = new Uint8Array(s.mask.width * s.mask.height);
      for (let i = 0; i < m.length; i++) m[i] = d[i] > 127 ? 1 : 0;
      segments.push({ label: s.label, score: s.score, mask: m, w: s.mask.width, h: s.mask.height });
      transfer.push(m.buffer);
    }
    post({ type: 'result', segments, timings: { load: t1 - t0, infer: t2 - t1 } }, transfer);
  } catch (err) {
    post({ type: 'error', message: (err && err.message) || String(err) });
  }
};
