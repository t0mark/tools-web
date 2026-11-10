// 실제 페이지를 헤드리스 Chromium(CPU/WASM)으로 끝까지 실행 (GitHub Actions 전용)
// 사용: node e2e.mjs <threads> <image...>
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '.github/sam3-test/out';
const [threads, ...images] = process.argv.slice(2);
const T0 = Date.now();
const ts = () => `${((Date.now() - T0) / 1000).toFixed(0)}s`;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${what}`)), ms))]);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage();
page.on('console', (m) => console.log(`  [${ts()} console.${m.type()}]`, m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log(`  [${ts()} pageerror]`, e.message));
page.on('crash', () => console.log(`  [${ts()} PAGE CRASHED]`));
page.on('worker', (w) => console.log(`  [${ts()} worker]`, w.url()));
page.on('dialog', (d) => { console.log(`  [${ts()} dialog]`, d.message()); d.accept(); });

await page.goto(`http://localhost:8000/tools/sam3-panoptic/?debug&threads=${threads}`);
await page.waitForTimeout(4000);
await page.waitForLoadState('load');
console.log('crossOriginIsolated:', await page.evaluate(() => self.crossOriginIsolated));

if (threads === '1') {
  const ref = JSON.parse(fs.readFileSync(`${OUT}/tok-ref.json`, 'utf8'));
  const tok = await page.evaluate(async (ref) => {
    const { ClipTokenizer } = await import('/tools/sam3-panoptic/clip-tokenizer.js');
    const data = await (await fetch('https://huggingface.co/rusen/sam3-browser-int8/resolve/970196bb75edfbcdab59567ee017673a4c53adc7/clip_tokenizer.json')).json();
    const tk = new ClipTokenizer(data);
    const bad = [];
    for (const [s, ids] of Object.entries(ref)) { const got = Array.from(tk.tokenize(s, 32)); if (got.join() !== ids.join()) bad.push({ s, got, ids }); }
    return { total: Object.keys(ref).length, bad };
  }, ref);
  console.log('TOKENIZER', tok.total - tok.bad.length, '/', tok.total, 'match', JSON.stringify(tok.bad).slice(0, 800));
}

await page.click('#key-card summary');
await page.selectOption('#ep-select', 'wasm');
try {
  for (const [i, img] of images.entries()) {
    const t = Date.now();
    await page.setInputFiles('#file-input', img);
    await page.waitForTimeout(1000);
    for (;;) {
      const st = await withTimeout(page.evaluate(() => ({ done: document.getElementById('loading').classList.contains('hidden') })), 60000, 'page.evaluate (main thread blocked?)');
      if (st.done) break;
      if (Date.now() - t > 9 * 60 * 1000) throw new Error('TIMEOUT 9min');
      await page.waitForTimeout(5000);
    }
    const err = await page.evaluate(() => !document.getElementById('error-box').classList.contains('hidden') && document.getElementById('error-text').textContent);
    console.log(`E2E threads=${threads} ${img}: ${(Date.now() - t) / 1000}s`, err ? `ERROR ${err}` : '');
    console.log('  timing:', await page.textContent('#timing'));
    console.log('  legend:', await page.$$eval('#legend button', (b) => b.map((x) => x.textContent).join(' | ')));
    await page.locator('.stage').screenshot({ path: `${OUT}/e2e-t${threads}-${i}.png` });
  }
} catch (e) {
  console.log(`[${ts()}] FAILED:`, e.message);
}
await withTimeout(browser.close(), 10000, 'close').catch(() => {});
process.exit(0);
