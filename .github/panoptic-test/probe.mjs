// 파놉틱 모델 후보 비교 (Node, transformers.js, CPU/WASM 단일 스레드)
// 사용: node probe.mjs <image...>
import { pipeline, env, RawImage } from '@huggingface/transformers';
import fs from 'node:fs';

env.backends.onnx.wasm.numThreads = 1;
const images = process.argv.slice(2);
const candidates = [
  ['Xenova/detr-resnet-50-panoptic', 'q8'], ['Xenova/detr-resnet-50-panoptic', 'fp16'], ['Xenova/detr-resnet-50-panoptic', 'fp32'],
  ['onnx-community/maskformer-swin-tiny-coco', 'q8'], ['onnx-community/maskformer-swin-tiny-coco', 'fp32'],
  ['onnx-community/maskformer-swin-small-coco', 'q8'],
  ['onnx-community/maskformer-swin-base-coco', 'q8'], ['onnx-community/maskformer-swin-base-coco', 'fp16'],
  ['onnx-community/mask2former-swin-tiny-coco-panoptic', 'q8'], ['Xenova/mask2former-swin-tiny-coco-panoptic', 'q8'],
];
for (const [model, dtype] of candidates) {
  const t0 = Date.now();
  try {
    const seg = await pipeline('image-segmentation', model, { dtype, device: 'wasm' });
    const tLoad = Date.now() - t0;
    for (const img of images) {
      const image = await RawImage.read(img);
      await seg(image, { subtask: 'panoptic' }); // 워밍업
      const t1 = Date.now();
      const out = await seg(image, { subtask: 'panoptic' });
      const dt = Date.now() - t1;
      // 덮인 픽셀 비율
      const w = image.width, h = image.height;
      const cover = new Uint8Array(w * h);
      for (const s of out) { const d = s.mask.data; for (let i = 0; i < d.length; i++) if (d[i]) cover[i] = 1; }
      const covered = cover.reduce((a, b) => a + b, 0) / (w * h);
      console.log(`OK ${model} [${dtype}] load ${tLoad}ms | ${img} ${w}x${h}: ${dt}ms, ${out.length} segs, covered ${(covered * 100).toFixed(1)}% :: ${out.map((s) => `${s.label}(${(s.score ?? 0).toFixed(2)})`).join(', ').slice(0, 400)}`);
    }
    // 모델 파일 크기
    const dir = `${env.cacheDir}/${model}/onnx`;
    if (fs.existsSync(dir)) console.log('   files:', fs.readdirSync(dir).map((f) => `${f} ${(fs.statSync(`${dir}/${f}`).size / 1e6).toFixed(1)}MB`).join(', '));
  } catch (e) {
    console.log(`FAIL ${model} [${dtype}]: ${String(e.message).slice(0, 200)}`);
  }
}
