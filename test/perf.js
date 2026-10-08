#!/usr/bin/env node
// Swipe performance profile: Playwright + CDP tracing at 412x915 (Pixel-like, touch) with 4x CPU throttling.
// Usage: node test/isolated.js test/perf.js            (temp data dir + port 8799, never the live server)
//   MD_PERF_PUBLIC=/path/to/public  -> serve app.js / styles.css / index.html from another copy (e.g. a baseline)
//   MD_PERF_OUT=file.json           -> where to write the results (default screenshots/perf.json)
// Measures, per gesture: frame intervals (rAF), main-thread frame cost (trace ProxyMain::BeginMainFrame), move
// input -> next frame latency, tap pointerup -> paint (Event Timing), release -> first fly frame, long tasks (>50 ms).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const BASE = process.env.MD_BASE;
if (!BASE || new URL(BASE).port === String(env.MD_PORT || 8787)) { console.error('run via: node test/isolated.js test/perf.js'); process.exit(2); }
const PUB = process.env.MD_PERF_PUBLIC;
const OUT = process.env.MD_PERF_OUT || path.join(ROOT, 'screenshots', 'perf.json');
const THROTTLE = +(process.env.MD_PERF_THROTTLE || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const stats = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? +Math.max(...a).toFixed(2) : null });

const PROBE = () => {
  // In-page probes. Nothing here changes app behaviour; it only listens (capture, passive) and records timestamps.
  const M = window.__perf = { run: 0, rec: false, frames: [], moves: [], downs: [], ups: [], events: [], longtasks: [], firstFlyFrame: null, upAt: null };
  const post = (fn) => { const ch = new MessageChannel(); ch.port1.onmessage = fn; ch.port2.postMessage(0); };
  const loop = (t) => { if (M.rec) M.frames.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // input -> next frame: the move's timestamp to the end of the next rendering opportunity (rAF, then a task after paint)
  const nextFrame = (ts, bucket) => requestAnimationFrame(() => post(() => { if (M.rec) bucket.push(performance.now() - ts); }));
  addEventListener('pointermove', (e) => { if (M.rec && e.buttons) nextFrame(e.timeStamp, M.moves); }, { capture: true, passive: true });
  addEventListener('pointerdown', (e) => { if (M.rec) nextFrame(e.timeStamp, M.downs); }, { capture: true, passive: true });
  addEventListener('pointerup', (e) => {
    if (!M.rec) return; nextFrame(e.timeStamp, M.ups);
    // release -> first frame where the released card has moved (fly-out / spring started)
    const t0 = e.timeStamp, run = M.run; const card = (e.target.closest && e.target.closest('.card')) || document.querySelector('.card[data-depth="0"]:not(.flying)');
    // cheap check (no forced style): inline transform changed, an animation is running, or the card is gone
    const start = card && card.style.transform; let n = 0;
    const moved = () => !card.isConnected || card.style.transform !== start || card.getAnimations().some((a) => a.playState === 'running');
    const watch = () => { if (++n > 90 || M.run !== run || M.firstFlyFrame != null) return; if (moved()) M.firstFlyFrame = performance.now() - t0; else requestAnimationFrame(watch); };
    if (card) requestAnimationFrame(watch);
  }, { capture: true, passive: true });
  try { new PerformanceObserver((l) => { if (M.rec) for (const e of l.getEntries()) M.events.push({ name: e.name, duration: e.duration, input: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart }); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch (_) {}
  try { new PerformanceObserver((l) => { if (M.rec) for (const e of l.getEntries()) M.longtasks.push(e.duration); }).observe({ type: 'longtask' }); } catch (_) {}
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, timezoneId: 'America/New_York',
    serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
  if (PUB) {
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
    await ctx.route(/\/(app\.js|styles\.css)(\?.*)?$|\/(\?.*)?$/, async (route) => {
      const u = new URL(route.request().url());
      if (route.request().resourceType() === 'document' && u.searchParams.has('token')) return route.continue(); // sign-in redirect
      const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      return route.fulfill({ status: 200, contentType: type[path.extname(f)], body: fs.readFileSync(path.join(PUB, f)) });
    });
  }
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?token=${env.MD_TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card[data-depth="0"][data-id]');
  await sleep(1500);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const topBox = async () => (await page.$('.card[data-depth="0"]:not(.flying)')).boundingBox();
  // Real-time finger at ~120 Hz (no custom timestamps, so event.timeStamp is the real dispatch time).
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }] });
  async function swipeGesture(dx, dy, { steps = 36, hz = 120, hold = 0 } = {}) {
    const b = await topBox(); const x0 = b.x + b.width / 2, y0 = b.y + b.height * 0.42;
    await touch('touchStart', x0, y0);
    let next = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = 1 - Math.pow(1 - t, 2); // finger accelerates then eases a little
      next += 1000 / hz; const wait = next - Date.now(); if (wait > 0) await sleep(wait);
      await touch('touchMove', x0 + dx * e, y0 + dy * e);
    }
    if (hold) await sleep(hold);
    await touch('touchEnd');
  }
  async function tapGesture() { const b = await topBox(); const x = b.x + b.width / 2, y = b.y + b.height * 0.55; await touch('touchStart', x, y); await sleep(50); await touch('touchEnd'); }

  const CATS = [...(process.env.MD_PERF_CATS_EXTRA ? process.env.MD_PERF_CATS_EXTRA.split(',') : []), 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'cc', 'benchmark', 'input', 'latencyInfo', 'toplevel'];
  async function measure(name, fn, settle = 900) {
    await page.evaluate(() => { const M = window.__perf; M.frames = []; M.moves = []; M.downs = []; M.ups = []; M.events = []; M.longtasks = []; M.firstFlyFrame = null; M.run++; M.rec = true; });
    const traceFile = path.join(path.dirname(OUT), `trace-${name}.json`);
    await browser.startTracing(page, { path: traceFile, categories: CATS });
    const t0 = Date.now();
    await fn();
    await sleep(settle);
    const wall = Date.now() - t0;
    const buf = await browser.stopTracing();
    const M = await page.evaluate(() => { const M = window.__perf; M.rec = false; return JSON.parse(JSON.stringify(M)); });
    const trace = JSON.parse(buf.toString()); const ev = trace.traceEvents || trace;
    const main = ev.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain' && ev.some((x) => x.pid === e.pid && x.name === 'ProxyMain::BeginMainFrame'));
    const onMain = (e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === 'X';
    const bmf = ev.filter((e) => onMain(e) && e.name === 'ProxyMain::BeginMainFrame').map((e) => e.dur / 1000);
    const tasks = ev.filter((e) => onMain(e) && (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask')).map((e) => e.dur / 1000);
    const layouts = ev.filter((e) => onMain(e) && e.name === 'Layout').length;
    const paints = ev.filter((e) => onMain(e) && (e.name === 'Paint' || e.name === 'PrePaint')).length;
    const styleRecalc = ev.filter((e) => onMain(e) && (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles')).map((e) => e.dur / 1000);
    const forced = ev.filter((e) => onMain(e) && (e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.args && e.args.beginData && e.args.beginData.stackTrace).length;
    const presented = ev.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b' && e.args && e.args.chrome_frame_reporter);
    const dropped = presented.filter((e) => /DROPPED/.test(e.args.chrome_frame_reporter.state || '')).length;
    const intervals = M.frames.slice(1).map((t, i) => t - M.frames[i]);
    if (!process.env.MD_PERF_KEEP_TRACE) fs.unlinkSync(traceFile); // big; the numbers below are what we keep
    return {
      name, wallMs: wall,
      frameIntervalMs: stats(intervals), framesOver25ms: intervals.filter((d) => d > 25).length, frames: intervals.length,
      mainThreadFrameMs: stats(bmf), mainFramesOver8_3ms: bmf.filter((d) => d > 8.33).length, mainFramesOver11_1ms: bmf.filter((d) => d > 11.1).length,
      longestTaskMs: tasks.length ? +Math.max(...tasks).toFixed(2) : null, longTasksTrace: tasks.filter((d) => d > 50).length, longTasksObserved: M.longtasks.length,
      moveToNextFrameMs: stats(M.moves), downToNextFrameMs: stats(M.downs), upToNextFrameMs: stats(M.ups),
      releaseToFirstMoveFrameMs: M.firstFlyFrame != null ? +M.firstFlyFrame.toFixed(1) : null,
      eventTiming: M.events.map((e) => `${e.name}:${Math.round(e.duration)}ms`),
      layouts, paints, styleRecalcMs: stats(styleRecalc), forcedLayoutsWithStack: forced, compositorFramesDropped: dropped,
    };
  }

  const results = { base: BASE, public: PUB || 'server', throttle: THROTTLE, viewport: '412x915@2.625', chrome: browser.version(), runs: [] };
  results.runs.push(await measure('drag-right-commit', () => swipeGesture(300, 30)));
  results.runs.push(await measure('drag-left-commit', () => swipeGesture(-300, 20)));
  results.runs.push(await measure('drag-springback', () => swipeGesture(-70, 10, { steps: 24, hz: 60, hold: 250 })));
  results.runs.push(await measure('drag-down-commit', () => swipeGesture(10, 420)));
  results.runs.push(await measure('fling-short-fast', () => swipeGesture(110, 6, { steps: 8 })));
  results.runs.push(await measure('single-tap', () => tapGesture(), 800));
  results.runs.push(await measure('button-swipe', () => page.click('.act[data-g="up"]').then(() => sleep(50)), 900));
  results.deckLeft = await page.evaluate(() => window.MorningDeck.state.deck.length);
  results.errors = errors;
  // headline numbers across the drag gestures
  const drags = results.runs.filter((r) => r.name.startsWith('drag') || r.name.startsWith('fling'));
  const all = (k, f) => drags.flatMap((r) => r[k] && r[k][f] != null ? [r[k][f]] : []);
  results.summary = {
    frameIntervalP95: Math.max(...all('frameIntervalMs', 'p95')), mainFrameP95: Math.max(...all('mainThreadFrameMs', 'p95')), mainFrameMax: Math.max(...all('mainThreadFrameMs', 'max')),
    moveLatencyP50: Math.max(...all('moveToNextFrameMs', 'p50')), moveLatencyP95: Math.max(...all('moveToNextFrameMs', 'p95')),
    longTasksDuringSwipes: drags.reduce((n, r) => n + r.longTasksTrace, 0), longestTask: Math.max(...drags.map((r) => r.longestTaskMs || 0)),
    framesOver25ms: drags.reduce((n, r) => n + r.framesOver25ms, 0), framesTotal: drags.reduce((n, r) => n + r.frames, 0),
    tapUpToNextFrame: results.runs.find((r) => r.name === 'single-tap').upToNextFrameMs.p50,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
