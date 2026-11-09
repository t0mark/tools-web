// 실제 페이지를 헤드리스 Chromium(CPU/WASM)으로 끝까지 실행 (GitHub Actions 전용)
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '.github/sam3-test/out';
const images = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage();
page.on('console', (m) => { const t = m.text(); if (/sam3|error|warn/i.test(t)) console.log('  [console]', m.type(), t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('dialog', (d) => { console.log('  [dialog]', d.message()); d.accept(); });

await page.goto('http://localhost:8000/tools/sam3-panoptic/');
await page.waitForTimeout(4000); // 서비스 워커 등록 후 1회 새로고침
await page.waitForLoadState('load');
console.log('crossOriginIsolated:', await page.evaluate(() => self.crossOriginIsolated));

// 토크나이저: JS 구현 vs transformers CLIPTokenizer
const ref = JSON.parse(fs.readFileSync(`${OUT}/tok-ref.json`, 'utf8'));
const tok = await page.evaluate(async (ref) => {
  const { ClipTokenizer } = await import('/tools/sam3-panoptic/clip-tokenizer.js');
  const data = await (await fetch('https://huggingface.co/rusen/sam3-browser-int8/resolve/970196bb75edfbcdab59567ee017673a4c53adc7/clip_tokenizer.json')).json();
  const tk = new ClipTokenizer(data);
  const bad = [];
  for (const [s, ids] of Object.entries(ref)) {
    const got = Array.from(tk.tokenize(s, 32));
    if (got.join() !== ids.join()) bad.push({ s, got, ids });
  }
  return { total: Object.keys(ref).length, bad };
}, ref);
console.log('TOKENIZER', tok.total - tok.bad.length, '/', tok.total, 'match', JSON.stringify(tok.bad).slice(0, 1500));

await page.click('#key-card summary');
await page.selectOption('#ep-select', 'wasm');
for (const [i, img] of images.entries()) {
  const t = Date.now();
  await page.setInputFiles('#file-input', img);
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 30 * 60 * 1000, polling: 2000 });
  const err = await page.evaluate(() => !document.getElementById('error-box').classList.contains('hidden') && document.getElementById('error-text').textContent);
  console.log(`E2E ${img}: ${(Date.now() - t) / 1000}s`, err ? `ERROR ${err}` : '');
  console.log('  timing:', await page.textContent('#timing'));
  console.log('  legend:', await page.$$eval('#legend button', (b) => b.map((x) => x.textContent).join(' | ')));
  await page.locator('.stage').screenshot({ path: `${OUT}/e2e-${i}.png` });
}
await browser.close();
