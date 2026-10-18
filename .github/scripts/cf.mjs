import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;

const TIER_KEY = /(premium|expire|date|limit|daily|count|left|remain|grade|plan|status|type|level)/i;

function describe(v, key = '', depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    return `array(${v.length})` + (v.length && depth < 3 ? ` of ${describe(v[0], key, depth + 1)}` : '');
  }
  const t = typeof v;
  if (t === 'boolean') return `boolean=${v}`;
  if (t === 'number') return TIER_KEY.test(key) ? `number=${v}` : 'number';
  if (t === 'string') return TIER_KEY.test(key) && v.length <= 30 ? `string="${v}"` : `string(len ${v.length})`;
  if (t === 'object') {
    if (depth >= 3) return 'object{…}';
    return '{ ' + Object.entries(v).slice(0, 30).map(([k, x]) => `${k}: ${describe(x, k, depth + 1)}`).join(', ') + ' }';
  }
  return t;
}

function contexts(src, needle, radius, cap) {
  const out = [];
  let from = 0;
  while (out.length < cap) {
    const i = src.indexOf(needle, from);
    if (i === -1) break;
    out.push(src.slice(Math.max(0, i - radius), Math.min(src.length, i + needle.length + radius)).replace(/\s+/g, ' '));
    from = i + needle.length + radius;
  }
  return out;
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

    console.log('→ signing in');
    await page.goto('https://anyipa.me/sign-in', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.fill('input[type="text"].form-control', USER);
    await page.fill('input[type="password"].form-control', PASS);
    await page.click('button.btn-primary');
    await page.waitForURL(/anyipa\.me\/?$/, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    console.log('→ signed in');

    // Account info (read-only by name; not verified)
    const info = await page.evaluate(async () => {
      const r = await fetch('/api/info');
      const text = await r.text();
      return { status: r.status, text };
    });
    let shape;
    try { shape = describe(JSON.parse(info.text)); } catch { shape = `text(len ${info.text.length})`; }
    console.log(`→ GET /api/info → ${info.status} ${shape}`);

    // Public frontend code around the endpoints not yet examined
    const bundleUrl = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')].map(s => s.src).find(s => s.includes('/static/js/main.'))
    );
    const src = await page.evaluate(u => fetch(u).then(r => r.text()), bundleUrl);
    console.log(`→ bundle ${bundleUrl.split('/').pop()} (${src.length} chars)`);

    for (const needle of [
      '/api/install/',
      '/api/feather/install',
      '/api/feather/cert',
      '/api/sign/',
      '/api/check/sign/',
      '/api/portal',
      '/api/pay/service/',
      '/api/info',
      '/api/download/',
    ]) {
      const hits = contexts(src, needle, 450, 4);
      console.log(`\n→ "${needle}" (${hits.length} hit${hits.length === 1 ? '' : 's'}):`);
      hits.forEach((h, i) => console.log(`  [${i + 1}] ${h}`));
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
