// All anyipa interactions run inside the Playwright browser session.
// CF cannot challenge fetch() calls made from within the same browser context.
// Outputs KEY=value lines to stdout; progress/debug to stderr.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createHash } from 'crypto';

chromium.use(StealthPlugin());

const BASE = 'https://anyipa.me';
const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;
const WORKER_URL = process.env.OUO_WORKER_URL;
const WORKER_SECRET = process.env.OUO_WORKER_SECRET;
const PASS_MD5 = PASS ? createHash('md5').update(PASS).digest('hex') : null;

function log(msg) { process.stderr.write(msg + '\n'); }

if (!USER || !PASS) { log('Missing ANYIPA_USER or ANYIPA_PASS'); process.exit(1); }
if (!WORKER_URL || !WORKER_SECRET) { log('Missing OUO_WORKER_URL or OUO_WORKER_SECRET'); process.exit(1); }

const browser = await chromium.launch({
  headless: false, // run under xvfb in CI; headed looks far less like a bot
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  colorScheme: 'light',
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();

// 1. Land on main page to clear CF challenge
log('Opening anyipa.me...');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
try {
  await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 25000 });
  log('CF passed');
} catch (e) {
  log('CF timeout, title: ' + (await page.title()));
}

// 2. Search — navigate so the page's own CF cookies are sent
log('Searching for Reddit...');
await page.goto(BASE + '/api/search/us/reddit', { waitUntil: 'domcontentloaded', timeout: 20000 });
try { await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 10000 }); } catch(e) {}
const searchText = await page.evaluate(() => document.body.innerText);
let entry;
try {
  const results = JSON.parse(searchText);
  entry = results.find(r => Number(r.app_id) === 1064216828);
} catch (e) {
  log('Search parse error: ' + searchText.slice(0, 300));
  process.exit(1);
}
if (!entry) { log('Reddit not found in results'); process.exit(1); }
log('Found: v' + entry.version + ' status=' + entry.status);
console.log('VERSION=' + entry.version);
console.log('STATUS=' + entry.status);

// 3. Login via sign-in page
log('Loading sign-in page...');
await page.goto(BASE + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
try {
  await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 45000 });
  log('CF passed on sign-in page');
} catch(e) {
  log('CF still blocking sign-in page — title: ' + (await page.title()));
  process.exit(1);
}
log('Filling form...');
await page.locator('input[type="text"].form-control').fill(USER);
await page.locator('input[type="password"].form-control').fill(PASS);
log('Submitting...');
const [loginResp] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/sign-in'), { timeout: 15000 }),
  page.locator('button.btn-primary').click(),
]);
log('Login HTTP ' + loginResp.status());
if (loginResp.status() !== 200) {
  log('Login body: ' + (await loginResp.text()).slice(0, 300));
  process.exit(1);
}

// 4. Download link
const APP_ID = entry.app_id;
const VER_ID = entry.app_ver_id;
log('Getting download link...');
const dlResult = await page.evaluate(async ({ base, appId, verId }) => {
  const r = await fetch(base + '/api/download/' + appId + '/' + verId, {
    credentials: 'include',
    headers: { 'Referer': base + '/' },
  });
  return { status: r.status, body: await r.text() };
}, { base: BASE, appId: APP_ID, verId: VER_ID });
log('Download HTTP ' + dlResult.status);
if (dlResult.status !== 200) {
  log('Download body: ' + dlResult.body.slice(0, 300));
  process.exit(1);
}

const url = dlResult.body.trim().replace(/^"|"$/g, '');

// Resolve ouo.io shortlink via Cloudflare Worker
log('Resolving via Worker...');
const workerResp = await fetch(WORKER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Secret': WORKER_SECRET },
  body: JSON.stringify({ url }),
});
const workerJson = await workerResp.json();
if (!workerResp.ok || !workerJson.resolved) {
  log('Worker error: ' + JSON.stringify(workerJson));
  await browser.close();
  process.exit(1);
}
const fileUrl = workerJson.resolved;
log('Worker resolved host: ' + new URL(fileUrl).hostname);

// 5. Download first bytes to verify it's a valid IPA (zip magic: 504b0304)
log('Verifying IPA magic...');
const headResp = await fetch(fileUrl, { method: 'GET', headers: { Range: 'bytes=0-3' } });
log('IPA fetch status: ' + headResp.status);
if (!headResp.ok) {
  log('IPA fetch failed');
  await browser.close();
  process.exit(1);
}
const buf = await headResp.arrayBuffer();
const magic = Buffer.from(buf).toString('hex');
log('IPA magic: ' + magic);

await browser.close();
console.log('DOWNLOAD_URL=' + fileUrl);
console.log('DOWNLOAD_MAGIC=' + magic);
