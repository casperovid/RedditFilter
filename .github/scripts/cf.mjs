// All anyipa interactions run inside the Playwright browser session.
// CF cannot challenge fetch() calls made from within the same browser context.
// Outputs KEY=value lines to stdout; progress/debug to stderr.

import { chromium } from 'playwright';

const BASE = 'https://anyipa.me';
const USER = process.env.ANYIPA_USER;
const PW_MD5 = process.env.ANYIPA_PASS_MD5; // MD5 computed by caller

function log(msg) { process.stderr.write(msg + '\n'); }

if (!USER || !PW_MD5) { log('Missing ANYIPA_USER or ANYIPA_PASS_MD5'); process.exit(1); }

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

// 3. Navigate to sign-in page so CF clears that path, then login
log('Loading sign-in page...');
await page.goto(BASE + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 20000 });
try { await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 10000 }); } catch(e) {}
log('Logging in...');
const loginResult = await page.evaluate(async ({ base, user, pw }) => {
  const r = await fetch(base + '/api/sign-in', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': base,
      'Referer': base + '/sign-in',
    },
    body: JSON.stringify({ id: user, pw: pw }),
    credentials: 'include',
  });
  return { status: r.status, body: await r.text() };
}, { base: BASE, user: USER, pw: PW_MD5 });
log('Login HTTP ' + loginResult.status);
if (loginResult.status !== 200) {
  log('Login body: ' + loginResult.body.slice(0, 300));
  process.exit(1);
}

// 4. Session check
const infoStatus = await page.evaluate(async ({ base }) => {
  const r = await fetch(base + '/api/info', { credentials: 'include' });
  return r.status;
}, { base: BASE });
log('Info HTTP ' + infoStatus);

// 5. Download link
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

// Strip surrounding quotes if the API returns a JSON string
const url = dlResult.body.trim().replace(/^"|"$/g, '');
console.log('DOWNLOAD_URL=' + url);

await browser.close();
