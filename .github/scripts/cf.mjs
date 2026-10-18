import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

function contexts(src, re, radius, cap) {
  const out = [];
  let m;
  while ((m = re.exec(src)) && out.length < cap) {
    const a = Math.max(0, m.index - radius);
    const b = Math.min(src.length, m.index + m[0].length + radius);
    out.push(src.slice(a, b).replace(/\s+/g, ' '));
    re.lastIndex = m.index + m[0].length + radius; // skip overlapping hits
  }
  return out;
}

async function main() {
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

    console.log('→ loading anyipa.me');
    await page.goto('https://anyipa.me/', { waitUntil: 'networkidle', timeout: 60_000 });

    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')].map(s => s.src)
    );
    const bundles = scripts.filter(s => s.includes('/static/js/') && s.endsWith('.js'));
    console.log(`→ bundles: ${bundles.map(b => b.split('/').pop()).join(', ')}`);

    for (const url of bundles) {
      const src = await page.evaluate(u => fetch(u).then(r => r.text()), url);
      console.log(`\n=== ${url.split('/').pop()}  (${src.length} chars) ===`);

      const paths = [...new Set([...src.matchAll(/["'`](\/api\/[^"'`\s]{1,80})["'`]/g)].map(m => m[1]))];
      console.log(`→ /api/ strings (${paths.length}):`);
      for (const p of paths) console.log('   ' + p);

      for (const [label, re, radius, cap] of [
        ['grade', /grade/gi, 160, 25],
        ['premium', /premium/gi, 160, 15],
        ['ouo', /ouo/gi, 200, 10],
      ]) {
        const hits = contexts(src, re, radius, cap);
        console.log(`\n→ "${label}" contexts (${hits.length}):`);
        hits.forEach((h, i) => console.log(`  [${i + 1}] ${h}`));
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
