import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

async function main() {
  if (!USER || !PASS) throw new Error('ANYIPA_USER / ANYIPA_PASS not set');
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    console.log('→ signing in');
    await page.goto('https://anyipa.me/sign-in', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.fill('input[type="text"].form-control', USER);
    await page.fill('input[type="password"].form-control', PASS);
    await page.click('button.btn-primary');
    await page.waitForURL(/anyipa\.me\/?$/, { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    console.log('→ signed in');

    // Known Reddit identifiers
    const APP_ID     = '1064216828';
    const APP_VER_ID = '892724836';

    // Probe /download/{candidate} — follow redirects and report where we end up
    const candidates = [
      APP_VER_ID,
      APP_ID,
      `${APP_ID}-${APP_VER_ID}`,
      APP_VER_ID.split('').reverse().join(''),   // just a sanity scramble
    ];

    for (const id of candidates) {
      const url = `https://anyipa.me/download/${id}`;
      const result = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { redirect: 'follow' });
          return { status: r.status, finalUrl: r.url, ok: r.ok };
        } catch (e) {
          return { error: e.message };
        }
      }, url);
      const dest = result.finalUrl || result.error || '(no url)';
      const isR2 = dest.startsWith('https://01bb7d075d994c2be13711816b337026');
      console.log(`/download/${id} → status=${result.status ?? '?'} r2=${isR2} dest=${isR2 ? '[R2]' : dest.slice(0, 120)}`);
    }

    // Also check: does the latest-entries list expose a direct IPA field?
    const latest = await page.evaluate(() =>
      fetch('/api/latest/0').then(r => r.json())
    );
    const reddit = latest.find(e => +e.app_id === 1064216828);
    if (reddit) {
      const keys = Object.keys(reddit).filter(k => {
        const v = String(reddit[k]);
        return v.startsWith('http') || v.includes('.ipa') || v.includes('download');
      });
      console.log(`\n→ Reddit entry URL-like fields: ${keys.length ? keys.map(k => `${k}=${String(reddit[k]).slice(0,80)}`).join(' | ') : 'none'}`);
    } else {
      console.log('\n→ Reddit not found in /api/latest/0');
    }

  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
