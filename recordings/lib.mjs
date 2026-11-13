// Shared helpers for AI governance demo UI recordings: Keycloak login, caption overlay, stopwatch, click highlight.
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DASH = process.env.DASH_URL;   // set by recordings/run.sh (scripts/lib.sh)
export const CONSOLE = process.env.CONSOLE_URL;
if (!DASH || !CONSOLE) throw new Error('run via recordings/run.sh (needs DASH_URL / CONSOLE_URL)');
export const KUBECONFIG = process.env.KUBECONFIG || `${process.env.HOME}/.kube/config`;   // same login as scripts/lib.sh

const OVERLAY = () => {
  if (window.top !== window) return;   // never inside iframes (avoids duplicate captions/stopwatch)
  if (window.__aigov) return;
  window.__aigov = true;
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return window['__' + k] || null; } } };
  const mk = () => {
    if (!document.body) return setTimeout(mk, 50);
    // remove any earlier overlay copy (init script + re-injection after setContent can both run)
    document.querySelectorAll('#aigov-caption, #aigov-stopwatch, #aigov-ff').forEach((e) => e.remove());
    const bar = document.createElement('div');
    bar.id = 'aigov-caption';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(21,21,21,.88);color:#fff;' +
      'font:600 20px/1.35 "Red Hat Text",Arial,sans-serif;padding:14px 28px;pointer-events:none;display:none';
    const sw = document.createElement('div');
    sw.id = 'aigov-stopwatch';
    sw.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#ee0000;color:#fff;' +
      'font:700 22px/1 monospace;padding:10px 14px;border-radius:6px;pointer-events:none;display:none';
    const ff = document.createElement('div');
    ff.id = 'aigov-ff';
    ff.style.cssText = 'position:fixed;top:14px;left:calc(50% + 110px);z-index:2147483647;background:#0066cc;color:#fff;' +
      'font:700 20px/1 "Red Hat Text",Arial,sans-serif;padding:11px 14px;border-radius:6px;pointer-events:none;display:none';
    document.body.append(bar, sw, ff);
    const cap = ss.get('aigov-caption');
    if (cap) { bar.textContent = cap; bar.style.display = 'block'; }
    setInterval(() => {
      const s = Number(ss.get('aigov-t0') || 0);
      if (s) {
        const e = Math.floor((Date.now() - s) / 1000);
        sw.textContent = `⏱ ${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
        sw.style.display = 'block';
      }
      const f = ss.get('aigov-ff');
      ff.textContent = f ? `⏩ ${f}× fast-forward · stopwatch shows real time` : '';
      ff.style.display = f ? 'block' : 'none';
    }, 250);
    document.addEventListener('click', (ev) => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${ev.clientX - 18}px;top:${ev.clientY - 18}px;width:36px;height:36px;border:3px solid #ee0000;` +
        'border-radius:50%;z-index:2147483647;pointer-events:none;transition:all .6s;opacity:1';
      document.body.append(r);
      setTimeout(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; }, 20);
      setTimeout(() => r.remove(), 700);
    }, true);
  };
  mk();
};

// Re-inject the overlay (captions, stopwatch, fast-forward badge) after page.setContent(), which skips init scripts.
export async function injectOverlay(page) {
  await page.evaluate(() => { window.__aigov = false; }).catch(() => {});
  await page.evaluate(OVERLAY).catch(() => {});
}

export async function start(name, { width = 1920, height = 1080, scale = Number(process.env.REC_SCALE || 1) } = {}) {
  const outDir = path.resolve('out', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  const framesDir = path.join(outDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.HEADED ? false : true });
  // High-quality capture: Chrome DevTools screencast (near-lossless JPEG per frame, real timestamps),
  // instead of Playwright's recordVideo (fixed low-bitrate VP8).
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ignoreHTTPSErrors: true });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const frames = [];
  const cdp = await context.newCDPSession(page);
  const pending = new Set();
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const n = frames.length;
    const file = path.join(framesDir, `f_${String(n).padStart(6, '0')}.jpg`);
    frames.push({ file, ts: metadata.timestamp || Date.now() / 1000 });
    const w = fs.promises.writeFile(file, Buffer.from(data, 'base64'));
    pending.add(w); w.finally(() => pending.delete(w));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const startCast = () => cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 95, maxWidth: width * scale, maxHeight: height * scale, everyNthFrame: 1 }).catch(() => {});
  await startCast();
  // cross-origin navigations (Keycloak <-> dashboard) can swap renderers: (re)start the screencast after each one
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) startCast(); });
  // First visit per user shows the "Welcome to OpenShift AI" tour dialog; close it whenever it appears.
  await page.addLocatorHandler(page.getByRole('dialog', { name: /Welcome to OpenShift AI/i }), async () => {
    const skip = page.getByTestId('whats-new-skip-tour');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else await page.getByRole('button', { name: 'Close' }).last().click().catch(() => {});
  });
  const rec = { browser, context, page, outDir, cdp, frames, pending, framesDir, width, height, scale, ffSegments: [], ff: null };
  return rec;
}

const setStore = (page, k, v) => page.evaluate(([k, v]) => {
  try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { window['__' + k] = v; }
}, [k, v]).catch(() => {});

export async function caption(page, text, holdMs = 1800) {
  await setStore(page, 'aigov-caption', text);
  await page.evaluate((t) => {
    document.querySelectorAll('#aigov-caption').forEach((b) => { b.textContent = t; b.style.display = t ? 'block' : 'none'; });
  }, text).catch(() => {});
  if (holdMs) await page.waitForTimeout(holdMs);
}

export async function startStopwatch(page) {
  await setStore(page, 'aigov-t0', String(Date.now()));
}

// Mark a waiting stretch: played back `factor`× faster in the MP4; an on-screen badge says so (stopwatch stays real time).
export async function fastForward(rec, page, factor = 8) {
  if (rec.ff) await normalSpeed(rec, page);
  rec.ff = { start: Date.now() / 1000, factor };
  await setStore(page, 'aigov-ff', String(factor));
}
export async function normalSpeed(rec, page) {
  if (rec.ff) { rec.ffSegments.push({ ...rec.ff, end: Date.now() / 1000 }); rec.ff = null; }
  await setStore(page, 'aigov-ff', null);
}

export async function login(page, user, password, url = DASH) {
  // The OpenShift console never fires "load" headless (long-lived connections): wait for DOM + the login form.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Username or email' }).waitFor({ timeout: 60000 });
  await page.getByRole('textbox', { name: 'Username or email' }).fill(user);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.href.includes('/realms/'), { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
  const skip = page.getByTestId('whats-new-skip-tour');
  if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) await skip.click();
}

export function oc(...args) {
  try {
    return execFileSync('oc', args, { env: { ...process.env, KUBECONFIG }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return '';   // e.g. NotFound while a resource is still being created
  }
}

export async function finish(rec, name) {
  const { browser, context, page, cdp, frames, pending, outDir, width, height } = rec;
  if (rec.ff) { rec.ffSegments.push({ ...rec.ff, end: Date.now() / 1000 }); rec.ff = null; }
  // playback duration of [a,b) real seconds, honouring fast-forward segments
  const play = (a, b) => {
    let d = b - a;
    for (const g of rec.ffSegments) {
      const o = Math.max(0, Math.min(b, g.end) - Math.max(a, g.start));
      d -= o - o / g.factor;
    }
    return d;
  };
  await page.waitForTimeout(1500);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all([...pending]);
  const end = Date.now() / 1000;
  await context.close();
  await browser.close();
  if (!frames.length) throw new Error('no frames captured');
  // concat list with each frame's real on-screen duration (screencast only emits frames on change)
  const lines = [];
  for (let k = 0; k < frames.length; k++) {
    const next = k + 1 < frames.length ? frames[k + 1].ts : end;
    const dur = Math.max(0.001, Math.min(play(frames[k].ts, next), 30));
    lines.push(`file '${frames[k].file.replace(/'/g, "'\\''")}'`, `duration ${dur.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  const list = path.join(outDir, 'frames.txt');
  fs.writeFileSync(list, lines.join('\n') + '\n');
  const mp4 = path.resolve('out', `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=30,scale=${width}:${height}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'stillimage', '-movflags', '+faststart', mp4]);
  // cut blank-white stretches (pages still loading); NO_TRIM=1 keeps them
  if (!process.env.NO_TRIM) {
    const trim = path.join(path.dirname(fileURLToPath(import.meta.url)), 'trim-blank.py');
    console.log(execFileSync('python3', [trim, mp4], { encoding: 'utf8' }).trim());
  }
  if (!process.env.KEEP_FRAMES) fs.rmSync(outDir, { recursive: true, force: true });   // frames + frames.txt
  console.log(`video: ${mp4} (${frames.length} frames, real ${(end - frames[0].ts).toFixed(0)} s, played ${play(frames[0].ts, end).toFixed(0)} s)`);
  return mp4;
}
