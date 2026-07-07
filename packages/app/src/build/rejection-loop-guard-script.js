/**
 * Inline guard injected at `head-prepend` by `rejectionLoopGuardPlugin`.
 * Read by the plugin via `readFileSync` at startup and injected verbatim
 * as `<script>` children. Tests import this file via `?raw` to assert
 * byte-equality with what the plugin emits — see
 * `rejection-loop-guard-plugin.ts` for why the plugin itself can't use
 * `?raw` (rolldown's config-load path doesn't resolve query imports).
 *
 * IIFE — no module imports, ever. This runs as a classic
 * <script type="text/javascript"> so it registers its `unhandledrejection`
 * listener BEFORE `@vite/client` (a deferred module script). Do not introduce
 * `import` or `export` here, and do not switch the consuming <script> tag in
 * `rejection-loop-guard-plugin.ts` to `type="module"` — both would put this
 * script on the same deferred queue as `@vite/client` and re-introduce the
 * registration race. `readFileSync` delivers the bytes as-authored. Targets
 * evergreen Chromium (Electron renderer + dev Chrome) so ES2020+ is fine.
 *
 * Match condition is belt-and-braces: literal message string OR `@vite/client`
 * substring in the stack. A future Vite wording change must not silently
 * disable the guard.
 */
(() => {
  if (window.__okViteRejectionGuardInstalled) return;
  window.__okViteRejectionGuardInstalled = true;
  var suppressed = 0;
  var warned = false;
  function isViteTransportRejection(reason) {
    if (!reason) return false;
    var msg = reason.message;
    if (typeof msg === 'string' && msg === 'send was called before connect') return true;
    var stack = reason.stack;
    if (typeof stack === 'string' && stack.indexOf('@vite/client') !== -1) return true;
    return false;
  }
  window.addEventListener('unhandledrejection', (event) => {
    if (!isViteTransportRejection(event.reason)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    suppressed += 1;
    if (!warned) {
      warned = true;
      console.warn(
        '[ok-dev] Vite module-runner transport disconnected — suppressing rejection feedback loop. Reload the page to reconnect.',
      );
    }
  });
  setInterval(() => {
    if (suppressed > 0) {
      console.warn(`[ok-dev] suppressed ${suppressed} Vite transport rejections in the last 5s`);
      suppressed = 0;
    }
  }, 5000);
})();
