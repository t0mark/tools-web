// Roboflow API 키를 비밀번호로 암호화해서 SAM 3 페이지(tools/sam3-panoptic/app.js)의 ENCRYPTED_KEY에 넣을 값을 만든다.
// 키·비밀번호는 파일에 남지 않도록 환경 변수로만 넘긴다.
//   KEY='...' PASSWORD='...' node scripts/encrypt-key.mjs
// 방식: PBKDF2-SHA256(비밀번호, 무작위 salt, 600,000회) → AES-256-GCM
import { webcrypto as crypto } from 'node:crypto';

const { KEY, PASSWORD } = process.env;
if (!KEY || !PASSWORD) {
  console.error('KEY 와 PASSWORD 환경 변수가 필요합니다.');
  process.exit(1);
}
const ITERATIONS = 600000;
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', enc.encode(PASSWORD), 'PBKDF2', false, ['deriveKey']);
const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(KEY)));
const b64 = (u) => Buffer.from(u).toString('base64');
console.log(JSON.stringify({ v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
