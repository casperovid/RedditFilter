import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawnSync } from 'child_process';
import fs from 'fs';
import https from 'https';

chromium.use(StealthPlugin());

const USER = process.env.ANYIPA_USER;
const PASS = process.env.ANYIPA_PASS;
const OUT  = process.env.IPA_OUTPUT || '/tmp/reddit.ipa';

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

    // ── Sign in ──────────────────────────────────────────────────────────────
    const page = await ctx.newPage();
    console.log('→ signing in');
    await page.goto('https://anyipa.me/sign-in', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.fill('input[type="text"].form-control', USER);
    await page.fill('input[type="password"].form-control', PASS);
    await page.click('button.btn-primary');
    await page.waitForURL(/anyipa\.me\/?$/, { timeout: 30_000 });
    console.log('→ signed in');

    // ── Search for Reddit ─────────────────────────────────────────────────────
    const entries = await page.evaluate(() =>
      fetch('/api/search/us/reddit').then(r => r.json())
    );
    const reddit = entries.find(e => +e.app_id === 1064216828);
    if (!reddit) throw new Error('Reddit not found in search results');
    const { app_id, app_ver_id, version } = reddit;
    console.log(`→ Reddit ${version}  app_id=${app_id}  app_ver_id=${app_ver_id}`);

    // ── Get download URL ──────────────────────────────────────────────────────
    const { dlStatus, dlText } = await page.evaluate(
      ([id, vid]) =>
        fetch(`/api/download/${id}/${vid}`).then(async r => ({
          dlStatus: r.status,
          dlText: await r.text(),
        })),
      [String(app_id), String(app_ver_id)]
    );

    if (dlStatus === 400) throw new Error(`Daily limit reached: ${dlText}`);
    if (dlStatus !== 200) throw new Error(`/api/download → ${dlStatus}: ${dlText}`);

    const dlUrl = dlText.trim();
    console.log(`→ /api/download returned: ${dlUrl.startsWith('https://01bb7d') ? '[direct R2]' : dlUrl}`);

    // ── Resolve to IPA URL ────────────────────────────────────────────────────
    let ipaUrl;

    if (dlUrl.startsWith('https://01bb7d075d994c2be13711816b337026')) {
      ipaUrl = dlUrl;
      console.log('→ direct R2 URL, skipping ouo.io');
    } else if (dlUrl.includes('ouo.io')) {
      const anyipaDlUrl = await resolveViaOuo(ctx, dlUrl);
      const cookies = await ctx.cookies(['https://anyipa.me']);
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      ipaUrl = await follow302(anyipaDlUrl, cookieStr);
      console.log('→ R2 URL resolved');
    } else {
      throw new Error(`Unrecognised /api/download response: ${dlUrl}`);
    }

    // ── Download IPA ──────────────────────────────────────────────────────────
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::add-mask::${ipaUrl}`);
    }
    console.log('→ downloading IPA');
    const dl = spawnSync('curl', ['-L', '--max-time', '300', '-o', OUT, ipaUrl], {
      stdio: 'inherit',
    });
    if (dl.status !== 0) throw new Error(`curl exited ${dl.status}`);

    // ── Verify ZIP magic ──────────────────────────────────────────────────────
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(OUT, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`Not a ZIP — magic bytes: ${buf.toString('hex')}`);
    }

    // ── Write GitHub Actions outputs ──────────────────────────────────────────
    const ghOut = process.env.GITHUB_OUTPUT;
    if (ghOut) {
      fs.appendFileSync(ghOut, `ipa_url=${ipaUrl}\nipa_version=${version}\n`);
    }
    console.log(`→ success  version=${version}  out=${OUT}`);

  } finally {
    await browser.close();
  }
}

async function resolveViaOuo(ctx, ouoUrl) {
  const pg = await ctx.newPage();
  let captured = null;

  await pg.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('https://anyipa.me/download/')) {
      captured = url;
      await route.abort();
    } else {
      await route.continue();
    }
  });

  console.log('→ navigating to ouo.io');
  try {
    await pg.goto(ouoUrl, { waitUntil: 'networkidle', timeout: 90_000 });
  } catch (e) {
    if (!captured) throw new Error(`ouo.io navigation failed: ${e.message}`);
  }

  // form.submit() bypasses the Turnstile JS guard on the button.
  // Server-side ouo.io doesn't validate x-token (confirmed in HAR: it was empty).
  if (!captured) {
    console.log(`→ ouo page URL: ${pg.url()}`);
    try {
      const result = await pg.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) return 'no form';
        form.submit();
        return 'submitted';
      });
      console.log(`→ form.submit(): ${result}`);
      await pg.waitForTimeout(15_000).catch(() => {});
    } catch (e) {
      console.log(`→ form.submit() error: ${e.message}`);
    }
  }

  if (!captured) {
    const cur = pg.url();
    if (cur.startsWith('https://anyipa.me/download/')) captured = cur;
  }

  await pg.close().catch(() => {});

  if (!captured) throw new Error('ouo.io → anyipa redirect was never captured');
  console.log('→ anyipa download URL captured');
  return captured;
}

function follow302(url, cookieStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': 'Mozilla/5.0',
      },
    }, res => {
      res.destroy();
      if (res.statusCode === 302 && res.headers.location) {
        resolve(res.headers.location);
      } else if (res.statusCode === 301 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        reject(new Error(`Expected 302 from anyipa /download/, got ${res.statusCode}`));
      }
    });
    req.on('error', reject);
  });
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
