// All anyipa interactions run inside the Playwright browser session.
// CF cannot challenge requests made from within the same browser context.
// Outputs key=value lines to stdout; progress to stderr.

import { chromium } from 'playwright';

const BASE = 'https://anyipa.me';
const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

function log(msg) { process.stderr.write(msg + '\n'); }

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

// 1. Land on main page — clears CF challenge
log('Opening anyipa.me...');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
try {
  await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 25000 });
  log('CF passed');
} catch (e) {
  log('CF timeout, title: ' + await page.title());
}

// 2. Search
log('Searching...');
await page.goto(BASE + '/api/search/us/reddit', { waitUntil: 'domcontentloaded', timeout: 20000 });
try { await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 10000 }); } catch(e) {}
const searchText = await page.evaluate(() => document.body.innerText);
let entry;
try {
  const results = JSON.parse(searchText);
  entry = results.find(r => r.app_id === 1064216828);
} catch(e) {
  log('Search parse error: ' + searchText.slice(0, 200));
  process.exit(1);
}
if (!entry) { log('Reddit not found in search results'); process.exit(1); }
log('Found: ' + entry.version + ' status=' + entry.status);
console.log('VERSION=' + entry.version);
console.log('STATUS=' + entry.status);

// 3. Login via fetch inside browser
log('Logging in...');
const md5 = await page.evaluate(async (user, pass) => {
  // Use SubtleCrypto for MD5 — not available, fall back to sending plain and letting server hash
  // Actually send raw password; server docs say pw should be md5
  const enc = new TextEncoder();
  const data = enc.encode(pass);
  const hashBuf = await crypto.subtle.digest('SHA-1', data); // SHA-1 as placeholder — we compute MD5 in bash and pass it
  return pass; // We'll pass precomputed MD5 via env
}, USER, PASS);

// Pass MD5 computed in shell via env
const pw_md5 = process.env.ANYIPA_PASS_MD5;
const loginResult = await page.evaluate(async (base, user, pw) => {
  const r = await fetch(base + '/api/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': base, 'Referer': base + '/sign-in' },
    body: JSON.stringify({ id: user, pw: pw }),
    credentials: 'include',
  });
  return { status: r.status, body: await r.text() };
}, BASE, USER, pw_md5);
log('Login HTTP ' + loginResult.status);
if (loginResult.status !== 200) {
  log('Login body: ' + loginResult.body.slice(0, 200));
  process.exit(1);
}

// 4. Check session
const infoResult = await page.evaluate(async (base) => {
  const r = await fetch(base + '/api/info', { credentials: 'include' });
  return r.status;
}, BASE);
log('Info HTTP ' + infoResult);

// 5. Get download link
const APP_ID = entry.app_id;
const VER_ID = entry.app_ver_id;
log('Getting download link...');
const dlResult = await page.evaluate(async (base, appId, verId) => {
  const r = await fetch(base + '/api/download/' + appId + '/' + verId, {
    credentials: 'include',
    headers: { 'Referer': base + '/' },
  });
  return { status: r.status, body: await r.text() };
}, BASE, APP_ID, VER_ID);
log('Download HTTP ' + dlResult.status);
if (dlResult.status !== 200) {
  log('Download body: ' + dlResult.body.slice(0, 200));
  process.exit(1);
}
console.log('DOWNLOAD_URL=' + dlResult.body.replace(/^"|"$/g, ''));

await browser.close();
