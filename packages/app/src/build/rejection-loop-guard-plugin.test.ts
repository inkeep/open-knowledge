import { describe, expect, test } from 'bun:test';
import { rejectionLoopGuardPlugin } from './rejection-loop-guard-plugin.ts';
import GUARD_SCRIPT from './rejection-loop-guard-script.js?raw';

describe('rejectionLoopGuardPlugin', () => {
  const plugin = rejectionLoopGuardPlugin();

  test('plugin name is namespaced', () => {
    expect(plugin.name).toBe('ok:rejection-loop-guard');
  });

  test('plugin is dev-only via apply: serve', () => {
    // `apply: 'serve'` is the structural gate — runtime `command` checks
    // would still let the plugin object enter the production plugin graph.
    expect(plugin.apply).toBe('serve');
  });

  test('transformIndexHtml runs pre-stage and injects to head-prepend', () => {
    const transform = plugin.transformIndexHtml as {
      order: string;
      handler: () => Array<{
        tag: string;
        injectTo: string;
        attrs?: Record<string, string>;
        children: string;
      }>;
    };
    expect(transform.order).toBe('pre');
    const tags = transform.handler();
    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe('script');
    expect(tags[0].injectTo).toBe('head-prepend');
  });

  test('script tag is type="text/javascript" (classic, not module) so it runs before deferred @vite/client', () => {
    // Load-bearing: classic scripts execute synchronously during HTML
    // parsing; module scripts (`type="module"`) are deferred until after
    // parsing completes. `@vite/client` is a module script, so a classic
    // script — regardless of its position in source order — registers its
    // listener first at runtime. Switching this to `type="module"` would
    // re-introduce a registration race against `@vite/client`.
    const transform = plugin.transformIndexHtml as {
      handler: () => Array<{ attrs?: Record<string, string> }>;
    };
    const tags = transform.handler();
    expect(tags[0].attrs?.type).toBe('text/javascript');
  });

  test('plugin children match the guard-script file byte-for-byte', () => {
    // Locks the wiring: the plugin loads the script via `readFileSync`;
    // this test loads it via `?raw`. They must yield identical bytes.
    // If the script file is renamed or a build step starts mutating it,
    // this catches the drift before the injected payload silently
    // diverges from the source.
    const transform = plugin.transformIndexHtml as {
      handler: () => Array<{ children: string }>;
    };
    const tags = transform.handler();
    expect(tags[0].children).toBe(GUARD_SCRIPT);
  });

  test('injected script installs idempotently via window flag', () => {
    expect(GUARD_SCRIPT).toContain('window.__okViteRejectionGuardInstalled');
    // Both the early-return and the set-flag must be present so HMR
    // re-injection doesn't double-register the listener.
    expect(GUARD_SCRIPT).toMatch(/if \(window\.__okViteRejectionGuardInstalled\) return;/);
    expect(GUARD_SCRIPT).toMatch(/window\.__okViteRejectionGuardInstalled = true;/);
  });

  test('match condition checks both message string and @vite/client stack', () => {
    // Belt-and-braces: a Vite wording change must not silently disable
    // the guard. The stack-trace fallback survives version bumps.
    expect(GUARD_SCRIPT).toContain("'send was called before connect'");
    expect(GUARD_SCRIPT).toContain("'@vite/client'");
  });

  test('listener calls stopImmediatePropagation and preventDefault', () => {
    // Both are required: stopImmediatePropagation prevents Vite's listener
    // from running (breaking the loop), preventDefault suppresses the
    // browser's default console error.
    expect(GUARD_SCRIPT).toContain('event.stopImmediatePropagation();');
    expect(GUARD_SCRIPT).toContain('event.preventDefault();');
  });

  test('warning logs at most once per session plus a 5-second bucket counter', () => {
    // At ~22,000 rejections/sec, an unbounded warn-per-event would itself
    // become a CPU hot-path. Initial warn-once + 5-second flush keeps
    // operational visibility without recreating the original storm.
    expect(GUARD_SCRIPT).toContain('warned = false');
    expect(GUARD_SCRIPT).toContain('warned = true');
    expect(GUARD_SCRIPT).toContain('setInterval');
    expect(GUARD_SCRIPT).toContain('5000');
  });

  test('script is parseable JavaScript', () => {
    // The injected body is a plain IIFE — no TypeScript, no module
    // imports. A syntax error here would silently disable the guard at
    // runtime; parse-check at test time catches that.
    expect(() => new Function(GUARD_SCRIPT)).not.toThrow();
  });

  test('guard behavior — simulated unhandledrejection flow', () => {
    // Set up a fake window with addEventListener so we can exercise the
    // script body and observe what it would do at runtime.
    const listeners: Array<(event: PromiseRejectionEvent) => void> = [];
    const fakeWindow = {
      __okViteRejectionGuardInstalled: undefined as boolean | undefined,
      addEventListener(type: string, listener: (event: PromiseRejectionEvent) => void) {
        if (type === 'unhandledrejection') listeners.push(listener);
      },
    };
    const warnCalls: string[] = [];
    const fakeConsole = {
      warn(msg: string) {
        warnCalls.push(msg);
      },
    };
    const fakeSetInterval = () => 0;
    new Function('window', 'console', 'setInterval', GUARD_SCRIPT)(
      fakeWindow,
      fakeConsole,
      fakeSetInterval,
    );

    expect(fakeWindow.__okViteRejectionGuardInstalled).toBe(true);
    expect(listeners).toHaveLength(1);

    let stopped = 0;
    let prevented = 0;
    function fireWith(reason: { message?: string; stack?: string } | null) {
      const event = {
        reason,
        stopImmediatePropagation() {
          stopped += 1;
        },
        preventDefault() {
          prevented += 1;
        },
      } as unknown as PromiseRejectionEvent;
      listeners[0](event);
    }

    // Literal-message match
    fireWith({ message: 'send was called before connect' });
    expect(stopped).toBe(1);
    expect(prevented).toBe(1);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('[ok-dev]');

    // Stack-trace match (survives a future Vite wording change)
    fireWith({ message: 'something else', stack: 'at @vite/client:518' });
    expect(stopped).toBe(2);
    expect(prevented).toBe(2);
    // Still only one warn — initial-warn-once contract holds.
    expect(warnCalls).toHaveLength(1);

    // Unrelated rejection passes through untouched
    fireWith({ message: 'unrelated app bug', stack: 'at App.tsx:42' });
    expect(stopped).toBe(2);
    expect(prevented).toBe(2);

    // Defensive: null reason must not crash
    fireWith(null);
    expect(stopped).toBe(2);
  });
});
