// Proportional scaling for laptop/desktop screens. The site is designed at
// UI_SCALE_REFERENCE_WIDTH — the narrowest window that fits a full row of 5
// card tiles (5 × 288px + 4 × 16px gaps + 2 × 32px page padding). Between
// UI_SCALE_MIN_WIDTH and that width the whole page is CSS-zoomed by
// (window width ÷ reference width), so every laptop shows the same layout
// as a big screen, just smaller. Wider windows render at 100%; narrower
// ones (tablets, phones) keep the ordinary responsive layout, since below
// 75% the text gets too small to read.
//
// Media queries still see the real window width, which is why the cutoff
// sits on MUI's `lg` breakpoint (1200px): every zoomed width already gets
// the same breakpoint values the reference screen does.
export const UI_SCALE_REFERENCE_WIDTH = 1600;
export const UI_SCALE_MIN_WIDTH = 1200;

// CSS viewport units are multiplied by the zoom too, so a zoomed page's
// `100vh` falls short of the window. Use this instead for full-height
// containers.
export const FULL_VIEWPORT_HEIGHT = "calc(100vh / var(--ui-scale, 1))";

// Runs inline in <head> before first paint (no flash of the unscaled
// layout), then again on every resize. Reads window.innerWidth rather than
// documentElement.clientWidth: the latter is reported in the zoomed
// element's own units, which would feed the zoom back into itself.
export const uiScaleScript = `(function () {
  var root = document.documentElement;
  function apply() {
    var w = window.innerWidth;
    var scale = w >= ${UI_SCALE_MIN_WIDTH} && w < ${UI_SCALE_REFERENCE_WIDTH} ? w / ${UI_SCALE_REFERENCE_WIDTH} : 1;
    root.style.setProperty("--ui-scale", String(scale));
    root.style.zoom = scale === 1 ? "" : String(scale);
  }
  apply();
  window.addEventListener("resize", apply);
})();`;
