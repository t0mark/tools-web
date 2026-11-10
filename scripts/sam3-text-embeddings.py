"""SAM 3 기기 실행용 텍스트 특징(text-embeddings.json/.bin) 생성

tools/sam3-panoptic/app.js 의 DEFAULT_THINGS / DEFAULT_STUFF 목록을 바꿨다면 이 스크립트로 다시 만든다.
  pip install onnxruntime numpy opencv-python-headless huggingface_hub transformers
  python scripts/sam3-text-embeddings.py [참조 실행할 이미지...]

- 토크나이저: transformers 의 CLIPTokenizer (openai/clip-vit-base-patch32, CLIP BPE와 동일)
- 모델: rusen/sam3-browser-int8 compact-448 (onnxruntime CPU). 텍스트 모델 약 355MB를 내려받는다.
- 이미지 경로를 주면 같은 모델로 참조 실행 결과(대상별 점수)를 출력한다.
"""
import json, re, sys, time
import numpy as np, onnxruntime as ort, cv2
from huggingface_hub import hf_hub_download
from transformers import CLIPTokenizer

REPO, SHA = 'rusen/sam3-browser-int8', '970196bb75edfbcdab59567ee017673a4c53adc7'
dl = lambda f: hf_hub_download(REPO, f, revision=SHA)
clip = CLIPTokenizer.from_pretrained('openai/clip-vit-base-patch32')


def tokenize(text, n=32):
    ids = clip(text.strip().lower(), add_special_tokens=True)['input_ids']
    if len(ids) > n:
        ids = ids[:n]
        ids[-1] = clip.eos_token_id
    return np.array(ids + [0] * (n - len(ids)), dtype=np.int32).reshape(1, n)


app = open('tools/sam3-panoptic/app.js').read()
things = [t.strip() for t in re.search(r"DEFAULT_THINGS = '([^']+)'", app).group(1).split(',')]
stuff = [t.strip() for t in re.search(r"DEFAULT_STUFF = '([^']+)'", app).group(1).split(',')]
prompts = things + stuff
print('prompts', len(prompts))

lang = ort.InferenceSession(dl('compact-448/sam3_language_encoder.onnx'), providers=['CPUExecutionProvider'])
blob = bytearray()
text = {}
for p in prompts:
    mask, memory, _ = lang.run(None, {'tokens': tokenize(p)})
    m = np.asarray(mask, dtype=np.uint8).reshape(32)
    f = np.asarray(memory, dtype=np.float32).reshape(32 * 256)
    blob += m.tobytes() + f.astype('<f4').tobytes()
    text[p] = (np.asarray(mask), np.asarray(memory, dtype=np.float32))
open('tools/sam3-panoptic/text-embeddings.bin', 'wb').write(blob)
json.dump({'model': f'{REPO}@{SHA} compact-448/sam3_language_encoder.onnx', 'seq': 32, 'dim': 256,
           'layout': 'per prompt: uint8 mask[32] + float32le memory[32*256]', 'prompts': prompts},
          open('tools/sam3-panoptic/text-embeddings.json', 'w'), ensure_ascii=False, indent=1)
print('embeddings bytes', len(blob))

if len(sys.argv) < 2:
    sys.exit(0)

enc = ort.InferenceSession(dl('compact-448/sam3_image_encoder_fp16.onnx'), providers=['CPUExecutionProvider'])
dec = ort.InferenceSession(dl('compact-448/sam3_decoder.onnx'), providers=['CPUExecutionProvider'])
for name in sys.argv[1:]:
    img = cv2.imread(name)
    h0, w0 = img.shape[:2]
    s = min(1, 512 / max(h0, w0))
    oh, ow = round(h0 * s), round(w0 * s)
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (448, 448), interpolation=cv2.INTER_LINEAR).transpose(2, 0, 1).copy()
    t = time.time()
    e = dict(zip([o.name for o in enc.get_outputs()], enc.run(None, {'image': x})))
    te = time.time() - t
    t = time.time()
    lines = []
    for p in prompts:
        m, f = text[p]
        boxes, scores, masks = dec.run(None, {
            'original_height': np.array(oh, np.int32), 'original_width': np.array(ow, np.int32),
            'vision_pos_enc_2': e['vision_pos_enc_2'], 'backbone_fpn_0': e['backbone_fpn_0'],
            'backbone_fpn_1': e['backbone_fpn_1'], 'backbone_fpn_2': e['backbone_fpn_2'],
            'language_mask': m.astype(bool), 'language_features': f,
            'box_coords': np.zeros((1, 1, 4), np.float32), 'box_labels': np.ones((1, 1), np.int32),
            'box_masks': np.ones((1, 1), bool)})
        sc = np.sort(scores)[::-1]
        if (sc >= 0.3).any():
            lines.append(f'  {p}: n={len(scores)} masks={masks.shape} >=0.3: {[round(float(v), 2) for v in sc[sc >= 0.3][:6]]}')
    print(f'REF {name} {w0}x{h0} -> masks {ow}x{oh}; encode {te:.1f}s, decode {len(prompts)} prompts {time.time() - t:.1f}s')
    print('\n'.join(lines))
