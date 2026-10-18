import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

async function main() {
  if (!USER || !PASS) throw new Error('ANYIPA_USER / ANYIPA_PASS not set');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();

    // Capture the sign-in response body so we can compare it to auth.grade
    let signInBody = null;
    page.on('response', async res => {
      try {
        const u = new URL(res.url());
        if (u.hostname === 'anyipa.me' && u.pathname === '/api/sign-in') {
          signInBody = (await res.text()).trim();
        }
      } catch { /* ignore */ }
    });

    console.log('→ signing in');
    await page.goto('https://anyipa.me/sign-in', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.fill('input[type="text"].form-control', USER);
    await page.fill('input[type="password"].form-control', PASS);
    await page.click('button.btn-primary');
    await page.waitForURL(/anyipa\.me\/?$/, { timeout: 30_000 });
    await page.waitForTimeout(5_000);
    console.log('→ signed in');

    // grade from saved app state
    const grade = await page.evaluate(() => {
      try {
        const top = JSON.parse(localStorage.getItem('persist:anyipa'));
        return JSON.parse(top.auth).grade;
      } catch { return null; }
    });
    console.log(`→ auth.grade = ${grade}`);
    console.log(`→ sign-in response equals auth.grade: ${signInBody !== null && String(grade) === signInBody}`);

    // Reddit entry fields + premium distribution (GET only, no /api/download)
    const info = await page.evaluate(async () => {
      const search = await fetch('/api/search/us/reddit').then(r => r.json());
      const latest = await fetch('/api/latest/0').then(r => r.json());
      const reddit = search.find(e => +e.app_id === 1064216828);
      const pick = {};
      if (reddit) {
        for (const [k, v] of Object.entries(reddit)) {
          if (k === 'RequestIP' || k === 'RequestUA') continue;
          if (typeof v === 'boolean') pick[k] = v;
          else if (typeof v === 'string' && v.length <= 10 && !/[:\/]/.test(v)) pick[k] = v;
        }
      }
      return {
        searchCount: search.length,
        reddit: pick,
        latestPremiumTrue: latest.filter(e => e.premium === true).length,
        latestPremiumFalse: latest.filter(e => e.premium === false).length,
        latestTotal: latest.length,
        searchPremiumTrue: search.filter(e => e.premium === true).length,
        searchPremiumFalse: search.filter(e => e.premium === false).length,
      };
    });
    console.log(`→ search results: ${info.searchCount}  (premium true=${info.searchPremiumTrue}, false=${info.searchPremiumFalse})`);
    console.log(`→ latest/0: ${info.latestTotal}  (premium true=${info.latestPremiumTrue}, false=${info.latestPremiumFalse})`);
    console.log('→ Reddit entry (short fields only): ' + JSON.stringify(info.reddit));
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
