import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

const TIER_KEY = /(type|level|plan|role|status|tier|vip|group|class|premium|free|quota|limit|count|point|credit|balance|left|remain)/i;

function describe(v, key = '', depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < 3 ? ` of ${describe(v[0], key, depth + 1)}` : '');
  const t = typeof v;
  if (t === 'boolean' || t === 'number') return `${t}=${v}`;
  if (t === 'string') return TIER_KEY.test(key) && v.length <= 20 ? `string="${v}"` : `string(len ${v.length})`;
  if (t === 'object') {
    if (depth >= 3) return 'object{…}';
    return '{ ' + Object.entries(v).map(([k, x]) => `${k}: ${describe(x, k, depth + 1)}`).join(', ') + ' }';
  }
  return t;
}

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

    const seen = [];
    page.on('response', async res => {
      try {
        const u = new URL(res.url());
        if (u.hostname !== 'anyipa.me' || !u.pathname.startsWith('/api/')) return;
        const req = res.request();
        let shape = '';
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await res.json().catch(() => null);
          // Search results are large and already known; only describe the rest
          shape = u.pathname.startsWith('/api/search/')
            ? `(search, ${Array.isArray(body) ? body.length : '?'} entries)`
            : describe(body);
        } else {
          shape = `(${ct || 'no content-type'})`;
        }
        seen.push(`${req.method()} ${u.pathname.replace(/\d{6,}/g, '<n>')} → ${res.status()} ${shape}`);
      } catch { /* ignore */ }
    });

    console.log('→ signing in');
    await page.goto('https://anyipa.me/sign-in', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.fill('input[type="text"].form-control', USER);
    await page.fill('input[type="password"].form-control', PASS);
    await page.click('button.btn-primary');
    await page.waitForURL(/anyipa\.me\/?$/, { timeout: 30_000 });
    await page.waitForTimeout(8_000);
    console.log('→ signed in');

    console.log('→ /api/ calls seen (no /api/download made):');
    for (const line of seen) console.log('   ' + line);

    // Cookie NAMES only, never values
    const cookies = await ctx.cookies(['https://anyipa.me']);
    console.log('→ cookie names: ' + cookies.map(c => c.name).join(', '));

    // Non-secret storage keys the app keeps, names only
    const keys = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    console.log('→ localStorage keys: ' + keys.local.join(', '));
    console.log('→ sessionStorage keys: ' + keys.session.join(', '));
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
