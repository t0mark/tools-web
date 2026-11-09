/*
 * SAM 3 기기 내 추론 워커 (ONNX Runtime Web)
 *
 * 모델: rusen/sam3-browser-int8 의 compact-448 (INT8 양자화, 입력 448×448)
 *  - 이미지 인코더(약 462MB) + 디코더(약 36MB)
 *  - 기본 대상 단어의 텍스트 특징은 미리 계산해 둔 파일(text-embeddings.*) 사용 → 텍스트 모델(355MB) 불필요
 *  - 목록에 없는 단어를 쓰면 그때만 텍스트 모델 + 토크나이저를 받아서 계산
 * 받은 모델은 Cache Storage에 저장해서 다음부터는 다운로드 없이 사용.
 */
import * as ort from '../../vendor/onnxruntime-web/ort.webgpu.min.mjs';
import { ClipTokenizer } from './clip-tokenizer.js';

const HF = 'https://huggingface.co/rusen/sam3-browser-int8/resolve/970196bb75edfbcdab59567ee017673a4c53adc7/';
const FILES = {
  encoder: { url: `${HF}compact-448/sam3_image_encoder_fp16.onnx`, size: 461907426, label: '이미지 모델' },
  decoder: { url: `${HF}compact-448/sam3_decoder.onnx`, size: 35713382, label: '디코더' },
  language: { url: `${HF}compact-448/sam3_language_encoder.onnx`, size: 354962329, label: '텍스트 모델' },
  tokenizer: { url: `${HF}clip_tokenizer.json`, size: 1487431, label: '토크나이저' },
};
const CACHE = 'sam3-models-v1';
const INPUT = 448;
const NMS_IOU = 0.7;

ort.env.wasm.wasmPaths = new URL('../../vendor/onnxruntime-web/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)) : 1;
ort.env.wasm.proxy = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
let sessions = {};
let ep = 'wasm';
let textTable = null; // Map(prompt → { mask: Uint8Array(32), feat: Float32Array(32*256) })
let tokenizer = null;

// ---------- 다운로드 + 캐시 ----------
async function cachedBytes(key) {
  const f = FILES[key];
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { /* 캐시 불가 환경 */ }
  if (cache) {
    const hit = await cache.match(f.url);
    if (hit) {
      post({ type: 'progress', key, label: f.label, loaded: f.size, total: f.size, cached: true });
      return new Uint8Array(await hit.arrayBuffer());
    }
  }
  const res = await fetch(f.url, { mode: 'cors' });
  if (!res.ok) throw new Error(`${f.label} 다운로드 실패 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || f.size;
  let body = res.body;
  let putPromise = null;
  if (cache && body && body.tee) {
    const [a, b] = body.tee();
    body = a;
    putPromise = cache.put(f.url, new Response(b, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total) } }))
      .catch((e) => post({ type: 'log', text: `캐시 저장 실패(용량 부족 등): ${e.message}` }));
  }
  const buf = new Uint8Array(total);
  let loaded = 0;
  let lastPost = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > buf.length) throw new Error(`${f.label} 크기가 예상과 다릅니다.`);
    buf.set(value, loaded);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 200) { lastPost = now; post({ type: 'progress', key, label: f.label, loaded, total }); }
  }
  post({ type: 'progress', key, label: f.label, loaded, total });
  if (putPromise) await putPromise;
  return loaded === buf.length ? buf : buf.subarray(0, loaded);
}

async function createSession(key) {
  const bytes = await cachedBytes(key);
  post({ type: 'stage', text: `${FILES[key].label} 준비 중…` });
  const opts = { graphOptimizationLevel: 'all' };
  if (ep === 'webgpu') {
    try {
      return await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['webgpu', 'wasm'] });
    } catch (e) {
      post({ type: 'log', text: `WebGPU 실패 → CPU로 전환: ${e.message}` });
      ep = 'wasm';
    }
  }
  return ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
}

async function loadTextTable() {
  const base = new URL('./', import.meta.url);
  const meta = await (await fetch(new URL('text-embeddings.json', base))).json();
  const bin = new Uint8Array(await (await fetch(new URL('text-embeddings.bin', base))).arrayBuffer());
  const table = new Map();
  const { seq, dim } = meta;
  const stride = seq + seq * dim * 4;
  meta.prompts.forEach((p, i) => {
    const off = i * stride;
    const mask = bin.slice(off, off + seq);
    const feat = new Float32Array(bin.slice(off + seq, off + stride).buffer);
    table.set(p, { mask, feat });
  });
  return table;
}

async function textFeatures(prompt) {
  if (textTable.has(prompt)) return textTable.get(prompt);
  if (!sessions.language) {
    post({ type: 'stage', text: '목록에 없는 단어가 있어 텍스트 모델을 준비합니다…' });
    const tokBytes = await cachedBytes('tokenizer');
    tokenizer = new ClipTokenizer(JSON.parse(new TextDecoder().decode(tokBytes)));
    sessions.language = await createSession('language');
  }
  const tokens = tokenizer.tokenize(prompt, 32);
  const out = await sessions.language.run({ tokens: new ort.Tensor('int32', tokens, [1, 32]) });
  const entry = { mask: new Uint8Array(out.text_attention_mask.data), feat: new Float32Array(out.text_memory.data) };
  textTable.set(prompt, entry);
  return entry;
}

// ---------- 후처리 ----------
function maskNms(masks, scores, w, h, iouThr) {
  // 마스크 IoU 기반 중복 제거 (참조 구현과 같이 긴 변 288 이하로 샘플링)
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 288));
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const sampled = masks.map((m) => {
    const s = new Uint8Array(sw * sh);
    let area = 0;
    for (let y = 0, k = 0; y < h; y += step) for (let x = 0; x < w; x += step, k++) { s[k] = m[y * w + x]; area += s[k]; }
    return { s, area };
  });
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const kept = [];
  const removed = new Set();
  for (const i of order) {
    if (removed.has(i)) continue;
    kept.push(i);
    for (const j of order) {
      if (j === i || removed.has(j) || kept.includes(j)) continue;
      let inter = 0;
      const a = sampled[i].s;
      const b = sampled[j].s;
      for (let k = 0; k < a.length; k++) inter += a[k] & b[k];
      const union = sampled[i].area + sampled[j].area - inter;
      if (union > 0 && inter / union > iouThr) removed.add(j);
    }
  }
  return kept;
}

// ---------- 메시지 ----------
self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      ep = msg.ep === 'webgpu' && 'gpu' in navigator ? 'webgpu' : 'wasm';
      if (!textTable) textTable = await loadTextTable();
      if (!sessions.decoder) sessions.decoder = await createSession('decoder');
      if (!sessions.encoder) sessions.encoder = await createSession('encoder');
      post({ type: 'ready', ep, threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated });
    } else if (msg.type === 'run') {
      const { pixels, outW, outH, prompts, thresh } = msg;
      const t0 = performance.now();
      post({ type: 'stage', text: '이미지 분석 중… (가장 오래 걸려요)' });
      const enc = await sessions.encoder.run({ image: new ort.Tensor('uint8', pixels, [3, INPUT, INPUT]) });
      const t1 = performance.now();

      const items = [];
      const transfer = [];
      const tDec = [];
      for (let p = 0; p < prompts.length; p++) {
        const prompt = prompts[p];
        post({ type: 'decode', done: p, total: prompts.length, prompt });
        const text = await textFeatures(prompt);
        const td = performance.now();
        const out = await sessions.decoder.run({
          original_height: new ort.Tensor('int32', Int32Array.of(outH), []),
          original_width: new ort.Tensor('int32', Int32Array.of(outW), []),
          vision_pos_enc_2: enc.vision_pos_enc_2,
          backbone_fpn_0: enc.backbone_fpn_0,
          backbone_fpn_1: enc.backbone_fpn_1,
          backbone_fpn_2: enc.backbone_fpn_2,
          language_mask: new ort.Tensor('bool', text.mask, [1, 32]),
          language_features: new ort.Tensor('float32', text.feat, [32, 1, 256]),
          box_coords: new ort.Tensor('float32', new Float32Array(4), [1, 1, 4]),
          box_labels: new ort.Tensor('int32', Int32Array.of(1), [1, 1]),
          box_masks: new ort.Tensor('bool', Uint8Array.of(1), [1, 1]),
        });
        tDec.push(performance.now() - td);
        const scores = Array.from(out.scores.data);
        const boxes = out.boxes.data;
        const n = scores.length;
        const [, , mh, mw] = out.masks.dims;
        const mdata = out.masks.data;
        const cand = [];
        for (let i = 0; i < n; i++) if (Number.isFinite(scores[i]) && scores[i] >= thresh) cand.push(i);
        const masks = cand.map((i) => {
          const m = new Uint8Array(mw * mh);
          const off = i * mw * mh;
          for (let k = 0; k < m.length; k++) m[k] = mdata[off + k] ? 1 : 0;
          return m;
        });
        const keep = maskNms(masks, cand.map((i) => scores[i]), mw, mh, NMS_IOU);
        for (const k of keep) {
          const i = cand[k];
          items.push({ prompt, confidence: scores[i], box: Array.from(boxes.slice(i * 4, i * 4 + 4)), mask: masks[k], w: mw, h: mh });
          transfer.push(masks[k].buffer);
        }
        post({ type: 'log', text: `${prompt}: 후보 ${n}개, 기준 이상 ${cand.length}개, 중복 제거 후 ${keep.length}개` });
        Object.values(out).forEach((t) => t.dispose && t.dispose());
      }
      Object.values(enc).forEach((t) => t.dispose && t.dispose());
      const t2 = performance.now();
      post({
        type: 'result',
        items,
        timings: { encode: t1 - t0, decode: t2 - t1, decodeEach: tDec.reduce((a, b) => a + b, 0) / Math.max(1, tDec.length) },
        ep,
      }, transfer);
    }
  } catch (err) {
    post({ type: 'error', message: (err && err.message) || String(err) });
  }
};
