// onnxruntime-web 버전/최적화 수준별로 SAM 3 인코더·디코더 로딩과 실행 시간 확인 (Node, WASM 단일 스레드)
// 사용: node ort-probe.mjs <ort-web 설치 경로> <encoder.onnx> <decoder.onnx>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [dir, encPath, decPath] = process.argv.slice(2);
const require = createRequire(path.resolve(dir, 'package.json'));
const ort = require('onnxruntime-web');
ort.env.wasm.numThreads = 1;
const ver = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules/onnxruntime-web/package.json'))).version;

for (const opt of ['all', 'extended', 'basic', 'disabled']) {
  let t = Date.now();
  try {
    const dec = await ort.InferenceSession.create(fs.readFileSync(decPath), { executionProviders: ['wasm'], graphOptimizationLevel: opt });
    const tDec = Date.now() - t;
    t = Date.now();
    const enc = await ort.InferenceSession.create(fs.readFileSync(encPath), { executionProviders: ['wasm'], graphOptimizationLevel: opt });
    const tEnc = Date.now() - t;
    t = Date.now();
    const img = new Uint8Array(3 * 448 * 448).map((_, i) => (i * 37) % 256);
    const out = await enc.run({ image: new ort.Tensor('uint8', img, [3, 448, 448]) });
    const tRun = Date.now() - t;
    t = Date.now();
    const d = await dec.run({
      original_height: new ort.Tensor('int32', Int32Array.of(384), []), original_width: new ort.Tensor('int32', Int32Array.of(512), []),
      vision_pos_enc_2: out.vision_pos_enc_2, backbone_fpn_0: out.backbone_fpn_0, backbone_fpn_1: out.backbone_fpn_1, backbone_fpn_2: out.backbone_fpn_2,
      language_mask: new ort.Tensor('bool', new Uint8Array(32).fill(1), [1, 32]), language_features: new ort.Tensor('float32', new Float32Array(32 * 256), [32, 1, 256]),
      box_coords: new ort.Tensor('float32', new Float32Array(4), [1, 1, 4]), box_labels: new ort.Tensor('int32', Int32Array.of(1), [1, 1]), box_masks: new ort.Tensor('bool', Uint8Array.of(1), [1, 1]),
    });
    console.log(`OK ort-web ${ver} opt=${opt}: decoder load ${tDec}ms, encoder load ${tEnc}ms, encoder run ${tRun}ms, decoder run ${Date.now() - t}ms, masks ${d.masks.dims}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL ort-web ${ver} opt=${opt}: ${String(e.message).slice(0, 200)}`);
  }
}
