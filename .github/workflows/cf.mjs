import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();
process.stderr.write('Opening anyipa.me...\n');
await page.goto('https://anyipa.me/', { waitUntil: 'domcontentloaded', timeout: 30000 });
try {
  await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 25000 });
  process.stderr.write('CF passed\n');
} catch (e) {
  process.stderr.write('CF title: ' + await page.title() + '\n');
}
const cookies = await ctx.cookies('https://anyipa.me');
const cf = cookies.find(c => c.name === 'cf_clearance');
const ua = await page.evaluate(() => navigator.userAgent);
console.log('UA=' + ua);
console.log('CF=' + (cf ? cf.value : ''));
await browser.close();
