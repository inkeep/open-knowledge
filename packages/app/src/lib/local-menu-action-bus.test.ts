import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkMenuAction, OkMenuActionOrigin } from './desktop-bridge-types';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
  subscribeLocalMenuAction,
} from './local-menu-action-bus';

describe('local menu-action bus', () => {
  afterEach(() => {
    __resetLocalMenuActionBusForTests();
  });

  test('emit reaches every subscriber exactly once (no double-fire)', () => {
    const a = vi.fn(() => {});
    const b = vi.fn(() => {});
    subscribeLocalMenuAction(a);
    subscribeLocalMenuAction(b);

    emitLocalMenuAction('toggle-sidebar');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenLastCalledWith('toggle-sidebar', { launcherBorne: false });
    expect(b).toHaveBeenLastCalledWith('toggle-sidebar', { launcherBorne: false });
  });

  test('the same handler subscribed once fires once per emit', () => {
    const handler = vi.fn(() => {});
    subscribeLocalMenuAction(handler);

    emitLocalMenuAction('new-terminal');
    emitLocalMenuAction('new-terminal');

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('unsubscribe stops delivery to that handler only', () => {
    const kept = vi.fn(() => {});
    const dropped = vi.fn(() => {});
    subscribeLocalMenuAction(kept);
    const unsubscribe = subscribeLocalMenuAction(dropped);

    unsubscribe();
    emitLocalMenuAction('duplicate');

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(0);
  });

  test('a handler that unsubscribes itself mid-dispatch still lets siblings run', () => {
    const order: string[] = [];
    let unsub: (() => void) | null = null;
    const first = vi.fn(() => {
      order.push('first');
      unsub?.();
    });
    const second = vi.fn(() => {
      order.push('second');
    });
    unsub = subscribeLocalMenuAction(first);
    subscribeLocalMenuAction(second);

    emitLocalMenuAction('rename');

    expect(order).toEqual(['first', 'second']);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a throwing subscriber does not block delivery to later subscribers', () => {
    const originalConsoleError = console.error;
    const errorSpy = vi.fn(() => {});
    console.error = errorSpy;
    try {
      const order: string[] = [];
      subscribeLocalMenuAction(() => {
        order.push('thrower');
        throw new Error('subscriber bug');
      });
      subscribeLocalMenuAction(() => {
        order.push('sibling');
      });

      expect(() => emitLocalMenuAction('rename')).not.toThrow();
      expect(order).toEqual(['thrower', 'sibling']);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('emitting with no subscribers is a no-op', () => {
    expect(() => emitLocalMenuAction('report-bug')).not.toThrow();
  });

  test('an emitter that declares itself launcher-borne delivers that origin', () => {
    const handler = vi.fn(() => {});
    subscribeLocalMenuAction(handler);

    emitLocalMenuAction('report-bug', { launcherBorne: true });

    expect(handler).toHaveBeenLastCalledWith('report-bug', { launcherBorne: true });
  });

  test('an emitter that declares nothing is launcher-free, not unclassified', () => {
    let seen: OkMenuActionOrigin | undefined;
    subscribeLocalMenuAction((_action, origin) => {
      seen = origin;
    });

    emitLocalMenuAction('report-bug');

    // A subscriber may read `origin.launcherBorne` without a null check, so the
    // default has to be a real origin rather than an absent second argument.
    expect(seen).toEqual({ launcherBorne: false });
  });
});

// The forwarder path reads `window.okDesktop`, absent in this non-DOM unit env.
// These tests stub it and MUST restore `globalThis.window` afterward — a leaked
// stub breaks unrelated non-DOM tests on Linux CI.
type InboundMenuAction = (action: OkMenuAction, origin: OkMenuActionOrigin) => void;

describe('local menu-action bus — bridge forwarder', () => {
  const originalWindow = globalThis.window;

  function setDesktop(okDesktop: unknown): void {
    globalThis.window = { okDesktop } as unknown as Window & typeof globalThis;
  }

  afterEach(() => {
    __resetLocalMenuActionBusForTests();
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  test('a single inbound native menu action fires each handler exactly once', () => {
    let inbound: InboundMenuAction | null = null;
    setDesktop({
      onMenuAction: (cb: InboundMenuAction) => {
        inbound = cb;
        return () => {};
      },
    });

    const handler = vi.fn(() => {});
    subscribeLocalMenuAction(handler);
    // The forwarder installed exactly one bridge listener.
    expect(inbound).not.toBeNull();
    // One inbound native action → exactly one handler invocation (no double-fire).
    inbound?.('toggle-sidebar', { launcherBorne: false });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenLastCalledWith('toggle-sidebar', { launcherBorne: false });
  });

  test('the forwarder hands subscribers the origin main stamped, not a default', () => {
    let inbound: InboundMenuAction | null = null;
    setDesktop({
      onMenuAction: (cb: InboundMenuAction) => {
        inbound = cb;
        return () => {};
      },
    });

    const handler = vi.fn(() => {});
    subscribeLocalMenuAction(handler);
    // Main classifies the dispatching surface; the forwarder must not re-decide.
    inbound?.('report-bug', { launcherBorne: true });

    expect(handler).toHaveBeenLastCalledWith('report-bug', { launcherBorne: true });
  });

  test('the forwarder installs once (ref-counted) and tears down when the last subscriber leaves', () => {
    let installs = 0;
    const unsubscribe = vi.fn(() => {});
    setDesktop({
      onMenuAction: () => {
        installs += 1;
        return unsubscribe;
      },
    });

    const off1 = subscribeLocalMenuAction(() => {});
    const off2 = subscribeLocalMenuAction(() => {});
    // One forwarder shared across subscribers, not one per subscriber.
    expect(installs).toBe(1);
    off1();
    expect(unsubscribe).toHaveBeenCalledTimes(0); // one subscriber remains
    off2();
    expect(unsubscribe).toHaveBeenCalledTimes(1); // last out → forwarder torn down
  });

  test('a partial bridge without onMenuAction never throws; direct emits still deliver', () => {
    setDesktop({}); // truthy-but-thin host (session-only / test stub)
    const handler = vi.fn(() => {});
    expect(() => subscribeLocalMenuAction(handler)).not.toThrow();
    emitLocalMenuAction('rename');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every production emitter, with the origin it declares.
 *
 * `emitLocalMenuAction`'s origin parameter defaults to launcher-free, and that
 * default is deliberate — a persistent chrome button IS launcher-free, and
 * spelling it out at twenty call sites would add noise for no information. The
 * exposure is one-directional and lands on this changeset's own subject: an
 * emitter that IS a transient overlay and forgets to say so compiles clean and
 * ships a bug report whose screenshot is a picture of the launcher the user
 * opened only in order to file it.
 *
 * Making the parameter required would enforce it in the type system at the cost
 * of ~22 argument edits across eleven unrelated test files. This is the same
 * enforcement for the cost of one list: a new emitter cannot land without
 * appearing here, so its provenance is a decision someone made rather than one
 * the default made for them.
 */
const EXPECTED_EMITTERS = [
  { file: 'components/CommandPalette.tsx', origins: ['{ launcherBorne: true }'] },
  {
    file: 'components/NavigationHistoryControls.tsx',
    origins: ['<default: launcher-free>', '<default: launcher-free>'],
  },
];

/** Argument text of each `emitLocalMenuAction(...)` call, paren-balanced. */
function emitCallArguments(source: string): string[] {
  const calls: string[] = [];
  const needle = 'emitLocalMenuAction(';
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return calls;
    let depth = 0;
    let end = at + needle.length - 1;
    for (let i = end; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(at + needle.length, end));
    from = end + 1;
  }
}

/** The origin argument as written, or the marker for "took the default". */
function declaredOrigin(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      const rest = args.slice(i + 1).trim();
      return rest.length > 0 ? rest : '<default: launcher-free>';
    }
  }
  return '<default: launcher-free>';
}

describe('local menu-action bus — production emitters declare their provenance', () => {
  test('the set of emitters and their declared origins is exactly the reviewed one', () => {
    const appSrc = join(import.meta.dir, '..');
    const isTestLike = (name: string) => /\.(test|dom\.test|test-helper)\.[cm]?tsx?$/.test(name);
    const found: { file: string; origins: string[] }[] = [];
    // A file that imports the emitter but whose calls this census cannot parse
    // — an aliased import, say — would otherwise fall through the `continue`
    // below and never reach `found`, leaving the exact-equality assertion to
    // pass with an unclassified emitter in the tree. That is the one outcome
    // this census exists to rule out, so make it loud instead.
    const importsButUnparsed: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.[cm]?tsx?$/.test(entry.name) || isTestLike(entry.name)) continue;
        const source = readFileSync(full, 'utf8');
        // The bus declares the function; it does not call it.
        if (full.endsWith('local-menu-action-bus.ts')) continue;
        const calls = emitCallArguments(source);
        if (calls.length === 0) {
          if (source.includes('emitLocalMenuAction'))
            importsButUnparsed.push(relative(appSrc, full));
          continue;
        }
        found.push({
          file: relative(appSrc, full),
          origins: calls.map(declaredOrigin),
        });
      }
    };
    walk(appSrc);

    expect(importsButUnparsed).toEqual([]);
    expect(found.sort((a, b) => a.file.localeCompare(b.file))).toEqual(EXPECTED_EMITTERS);
  });
});
