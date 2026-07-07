/**
 * Vite plugin: inject an `unhandledrejection` guard before `@vite/client` to
 * break a self-amplifying feedback loop in Vite's dev-only error forwarder.
 *
 * The loop: Vite's `@vite/client` registers a `window.addEventListener(
 * 'unhandledrejection', ...)` handler that forwards browser errors to the
 * dev server. The handler calls `sendError()` → `transport.send()`. The
 * `send` method is `async` and synchronously throws `new Error("send was
 * called before connect")` when the Vite module-runner transport is
 * disconnected. Because Vite's `sendError` drops the returned promise, that
 * throw becomes another unhandled rejection — which triggers the same
 * handler, which throws again. Observed in a Chrome DevTools trace at
 * ~22,000 iterations/sec, growing the renderer process to >1.5 GB before
 * GC keeps up.
 *
 * We cannot fix Vite's source directly. Instead we inject the contents of
 * `./rejection-loop-guard-script.js` (read via `readFileSync` at plugin
 * startup — see rolldown constraint below) as an inline
 * `<script type="text/javascript">`. The `type="text/javascript"` choice
 * is load-bearing: classic scripts execute synchronously during HTML
 * parsing, while module scripts (`type="module"`, like `@vite/client`)
 * are deferred until after parsing completes. So even though Vite's
 * `<script>` tag appears earlier in source order than ours, our listener
 * registers first at runtime. Do not change this to `type="module"` —
 * doing so would put our listener on the same deferred queue as Vite's
 * and registration order would become dependent on plugin ordering and
 * Vite version.
 *
 * When the loop-causing rejection fires our listener calls
 * `stopImmediatePropagation()` — on a `window`-targeted event with no
 * DOM propagation path, this stops every remaining listener regardless
 * of capture/bubble phase — and `preventDefault()` to suppress the
 * browser's default console error. One initial `console.warn` and a
 * 5-second-bucketed counter give operational visibility without
 * re-creating the storm.
 *
 * `apply: 'serve'` keeps the plugin out of production builds entirely —
 * `@vite/client` does not ship in `vite build` output, so the guard is
 * irrelevant there.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// `?raw` would be the natural import, but rolldown — used to bundle
// `vite.config.ts` itself before Vite starts — does not resolve `?raw`
// in the config-load path and exits with `UNLOADABLE_DEPENDENCY`.
// `readFileSync` at module load is the same shape `chrome-tokens-vite-plugin.ts`
// uses (it reads `globals.css`) and is the established workaround in this
// build/ directory.
const GUARD_SCRIPT_PATH = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  './rejection-loop-guard-script.js',
);

export function rejectionLoopGuardPlugin(): Plugin {
  const guardScript = readFileSync(GUARD_SCRIPT_PATH, 'utf-8');
  return {
    name: 'ok:rejection-loop-guard',
    // `apply: 'serve'` is Vite's first-class mechanism for keeping a plugin
    // out of production builds. We do not check `command` inside the hook —
    // the gate is structural.
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'text/javascript' },
            children: guardScript,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}
