// Test helper: mark the first-run tour as done before any page script runs, so suites that
// exercise the deck aren't blocked by the tour (it auto-starts ~0.5s after load on fresh data
// and moves focus to .tour-skip). Accepts a Browser (wraps newContext) or a BrowserContext.
// test/tour.js covers the tour itself on fresh data.
const init = () => { try { localStorage.setItem('md_tour_done', '1'); } catch (_) {} };
module.exports = function skipTour(target) {
  if (typeof target.addInitScript === 'function') return target.addInitScript(init);
  const orig = target.newContext.bind(target);
  target.newContext = async (...a) => { const ctx = await orig(...a); await ctx.addInitScript(init); return ctx; };
  return target;
};
