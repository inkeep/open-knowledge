import { describe, expect, test } from 'vitest';
import { rejectionLoopGuardPlugin } from './rejection-loop-guard-plugin.ts';
import GUARD_SCRIPT from './rejection-loop-guard-script.js?raw';

describe('rejectionLoopGuardPlugin', () => {
  const plugin = rejectionLoopGuardPlugin();

  test('plugin name is namespaced', () => {
    expect(plugin.name).toBe('ok:rejection-loop-guard');
  });

  test('plugin is dev-only via apply: serve', () => {
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
    const transform = plugin.transformIndexHtml as {
      handler: () => Array<{ attrs?: Record<string, string> }>;
    };
    const tags = transform.handler();
    expect(tags[0].attrs?.type).toBe('text/javascript');
  });

  test('the injected bytes carry the STOP marker that guards the classic-script contract', () => {
    const transform = plugin.transformIndexHtml as {
      handler: () => Array<{ children: string }>;
    };
    const injected = transform.handler()[0].children;
    expect(injected).toMatch(/STOP: /);
    expect(injected).toContain('rejection-loop-guard-plugin.ts');
    expect(injected).toContain('type="module"');
  });

  test('plugin children match the guard-script file byte-for-byte', () => {
    const transform = plugin.transformIndexHtml as {
      handler: () => Array<{ children: string }>;
    };
    const tags = transform.handler();
    expect(tags[0].children).toBe(GUARD_SCRIPT);
  });

  test('injected script installs idempotently via window flag', () => {
    expect(GUARD_SCRIPT).toContain('window.__okViteRejectionGuardInstalled');
    expect(GUARD_SCRIPT).toMatch(/if \(window\.__okViteRejectionGuardInstalled\) return;/);
    expect(GUARD_SCRIPT).toMatch(/window\.__okViteRejectionGuardInstalled = true;/);
  });

  test('match condition checks both message string and @vite/client stack', () => {
    expect(GUARD_SCRIPT).toContain("'send was called before connect'");
    expect(GUARD_SCRIPT).toContain("'@vite/client'");
  });

  test('listener calls stopImmediatePropagation and preventDefault', () => {
    expect(GUARD_SCRIPT).toContain('event.stopImmediatePropagation();');
    expect(GUARD_SCRIPT).toContain('event.preventDefault();');
  });

  test('warning logs at most once per session plus a 5-second bucket counter', () => {
    expect(GUARD_SCRIPT).toContain('warned = false');
    expect(GUARD_SCRIPT).toContain('warned = true');
    expect(GUARD_SCRIPT).toContain('setInterval');
    expect(GUARD_SCRIPT).toContain('5000');
  });

  test('script is parseable JavaScript', () => {
    expect(() => new Function(GUARD_SCRIPT)).not.toThrow();
  });

  test('guard behavior — simulated unhandledrejection flow', () => {
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

    fireWith({ message: 'send was called before connect' });
    expect(stopped).toBe(1);
    expect(prevented).toBe(1);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('[ok-dev]');

    fireWith({ message: 'something else', stack: 'at @vite/client:518' });
    expect(stopped).toBe(2);
    expect(prevented).toBe(2);
    expect(warnCalls).toHaveLength(1);

    fireWith({ message: 'unrelated app bug', stack: 'at App.tsx:42' });
    expect(stopped).toBe(2);
    expect(prevented).toBe(2);

    fireWith(null);
    expect(stopped).toBe(2);
  });
});
