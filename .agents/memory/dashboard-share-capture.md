---
name: Client-side dashboard image capture
description: Lessons from the dashboard Share-as-image feature (html-to-image, fonts, dev-server traps)
---

The dashboard Share button captures the page client-side and downloads a PNG
(or hands it to `navigator.share` where that exists).

**Rules learned the hard way:**
- **html2canvas cannot parse modern color functions** — Tailwind v4 emits
  `oklab()`/`oklch()` and html2canvas 1.4.1 throws `Attempting to parse an
  unsupported color function "oklab"`. Use `html-to-image` instead: it renders
  via SVG `<foreignObject>`, so the browser itself paints the clone and every
  modern color works for free.
- **Font embedding needs CORS-readable stylesheets.** `cssRules` on a
  cross-origin sheet throws SecurityError, so html-to-image silently falls back
  to system fonts. Google Fonts links must carry `crossorigin="anonymous"`
  (Google sends CORS headers), and a CSS `@import url(...)` font sheet is
  CORS-opaque *by construction* — move it to a `<link crossorigin>` in
  index.html.
- **Lazy imports of a new dep reload the dev page.** Vite's "new dependency
  optimized" reload fires on the FIRST dynamic import and silently discards the
  in-flight action. Add lazily-imported deps to `optimizeDeps.include`.
- **Don't gate the button on query `isLoading`** — a disabled window swallows
  clicks with zero feedback (and made automated tests report "nothing
  happened"). Gate only on the capture being in flight.
- **Keep the console breadcrumbs** (`share: capturing…` / `share failed`):
  the failure modes above are all silent without them.
- `navigator.share`/`canShare` are `undefined` in desktop/headless Chromium —
  the download branch is the one tests exercise; AbortError from a dismissed
  share sheet is not an error.
