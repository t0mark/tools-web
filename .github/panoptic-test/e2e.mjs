// 실제 페이지 E2E (헤드리스 Chromium) — 임시 검증용
import { chromium } from 'playwright';
const OUT = '.github/panoptic-test/out';
const images = process.argv.slice(2);
const T0 = Date.now();
const ts = () => `${((Date.now() - T0) / 1000).toFixed(0)}s`;
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage();
page.on('console', (m) => { if (m.type() !== 'log' && m.type() !== 'debug') console.log(`  [${ts()} console.${m.type()}]`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log(`  [${ts()} pageerror]`, e.message));
page.on('crash', () => console.log(`  [${ts()} PAGE CRASHED]`));
await page.goto('http://localhost:8000/');
await page.screenshot({ path: `${OUT}/home.png` });
await page.click('a[href="tools/panoptic/"]');
await page.waitForSelector('#dropzone');
for (const [i, img] of images.entries()) {
  const t = Date.now();
  await page.setInputFiles('#file-input', img);
  await page.waitForTimeout(500);
  let last = '';
  for (;;) {
    const st = await page.evaluate(() => ({ done: document.getElementById('loading').classList.contains('hidden'), text: document.getElementById('loading-text').textContent }));
    if (st.done) break;
    if (st.text !== last && !/MB/.test(st.text)) { console.log(`  [${((Date.now() - t) / 1000).toFixed(0)}s] ${st.text}`); last = st.text; }
    if (Date.now() - t > 8 * 60 * 1000) { console.log('TIMEOUT'); break; }
    await page.waitForTimeout(1000);
  }
  const err = await page.evaluate(() => !document.getElementById('error-box').classList.contains('hidden') && document.getElementById('error-text').textContent);
  console.log(`E2E ${img}: ${(Date.now() - t) / 1000}s`, err ? `ERROR ${err}` : '');
  console.log('  count:', await page.textContent('#seg-count'), '| timing:', await page.textContent('#timing'));
  console.log('  legend:', (await page.$$eval('#legend button', (b) => b.map((x) => x.textContent).join(' | '))).slice(0, 700));
  await page.locator('.stage').screenshot({ path: `${OUT}/e2e-${i}.png` });
  if (i === 0) await page.screenshot({ path: `${OUT}/e2e-full.png`, fullPage: true });
}
await browser.close();
