import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

chromium.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHALLENGE = /just a moment|security verification|attention required|checking your browser/i;
const TOR_PORT = 9150;

async function probe(label, proxy) {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  let passed = true;
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    if (proxy) {
      try {
        await page.goto('https://check.torproject.org/api/ip', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const body = await page.evaluate(() => document.body.innerText);
        console.log(`[${label}] check.torproject.org IsTor=${JSON.parse(body).IsTor}`);
      } catch (e) {
        console.log(`[${label}] Tor check failed: ${e.message.split('\n')[0]}`);
      }
    }

    for (const url of ['https://ouo.io/', 'https://ouo.io/AAAAAA']) {
      let status = 'none';
      let title = '';
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        status = resp ? resp.status() : 'none';
        for (let i = 0; i < 20; i++) {           // up to ~40 s for the challenge to clear
          title = await page.title();
          if (!CHALLENGE.test(title)) break;
          await page.waitForTimeout(2_000);
        }
      } catch (e) {
        title = `(error: ${e.message.split('\n')[0].slice(0, 80)})`;
      }
      const cleared = !CHALLENGE.test(title) && !title.startsWith('(error');
      if (!cleared) passed = false;
      console.log(`[${label}] ${url}  firstStatus=${status}  cleared=${cleared}  title="${title.slice(0, 70)}"`);
    }
  } finally {
    await browser.close();
  }
  return passed;
}

function installTor() {
  spawnSync('sudo', ['apt-get', 'update', '-qq'], { stdio: 'ignore' });
  const r = spawnSync('sudo', ['apt-get', 'install', '-y', '-qq', 'tor'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`apt-get install tor failed (${r.status})`);
}

function startTor() {
  fs.rmSync('/tmp/tor-data', { recursive: true, force: true });
  fs.mkdirSync('/tmp/tor-data', { mode: 0o700 });
  const proc = spawn('tor', ['--SocksPort', String(TOR_PORT), '--DataDirectory', '/tmp/tor-data'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('tor bootstrap timeout (120 s)')); }, 120_000);
    proc.stdout.on('data', d => {
      buf += d.toString();
      if (/Bootstrapped 100%/.test(buf)) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`tor exited early (${code})`)); });
  });
}

async function main() {
  console.log('=== baseline: direct from runner ===');
  await probe('direct', null);

  console.log('\n=== installing Tor ===');
  installTor();

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`\n=== Tor attempt ${attempt}/3 (fresh circuit) ===`);
    let tor;
    try {
      tor = await startTor();
      console.log('→ tor bootstrapped');
      const ok = await probe(`tor#${attempt}`, `socks5://127.0.0.1:${TOR_PORT}`);
      if (ok) { console.log('→ ouo.io challenge CLEARED via Tor'); return; }
    } catch (e) {
      console.log(`→ attempt ${attempt} error: ${e.message}`);
    } finally {
      if (tor) { tor.removeAllListeners('exit'); tor.kill(); }
    }
  }
  console.log('→ ouo.io challenge did NOT clear via Tor in 3 attempts');
}

main().catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
