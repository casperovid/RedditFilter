import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

const TIER_KEY = /(type|level|plan|role|status|tier|vip|group|class|premium|free|quota|limit|count|point|credit|balance|left|remain|expire|until|allow)/i;

function describe(v, key = '', depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    return `array(${v.length})` + (v.length && depth < 4 ? ` of ${describe(v[0], key, depth + 1)}` : '');
  }
  const t = typeof v;
  if (t === 'boolean') return `boolean=${v}`;
  if (t === 'number') return TIER_KEY.test(key) ? `number=${v}` : 'number';
  if (t === 'string') return TIER_KEY.test(key) && v.length <= 20 ? `string="${v}"` : `string(len ${v.length})`;
  if (t === 'object') {
    if (depth >= 4) return 'object{…}';
    const entries = Object.entries(v).slice(0, 40);
    return '{ ' + entries.map(([k, x]) => `${k}: ${describe(x, k, depth + 1)}`).join(', ') + ' }';
  }
  return t;
}

function describeText(text) {
  try {
    return describe(JSON.parse(text));
  } catch {
    return `text(len ${text.length})`;
  }
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
        const text = await res.text().catch(() => '');
        const shape = u.pathname.startsWith('/api/search/')
          ? `(search, len ${text.length})`
          : describeText(text);
        seen.push(`${res.request().method()} ${u.pathname.replace(/\d{6,}/g, '<n>')} → ${res.status()} ${shape}`);
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

    console.log('→ /api/ responses (shape only, no /api/download made):');
    for (const line of seen) console.log('   ' + line);

    // Saved app state: parse redux-persist style values, print shape only
    const persisted = await page.evaluate(() => localStorage.getItem('persist:anyipa'));
    if (!persisted) {
      console.log('→ persist:anyipa is empty');
    } else {
      console.log('→ persist:anyipa shape:');
      let top;
      try { top = JSON.parse(persisted); } catch { top = null; }
      if (!top) {
        console.log(`   not JSON (len ${persisted.length})`);
      } else {
        for (const [k, raw] of Object.entries(top)) {
          let parsed = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          console.log(`   ${k}: ${describe(parsed, k)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
