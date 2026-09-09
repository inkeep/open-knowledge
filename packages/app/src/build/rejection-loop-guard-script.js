/* STOP: rejection-loop-guard-plugin.ts injects this file verbatim as a classic
   <script type="text/javascript"> so its listener registers before the deferred
   @vite/client module script. An import or export here, or type="module" on that
   tag, puts this on the same deferred queue and loses the race it exists to win. */
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
