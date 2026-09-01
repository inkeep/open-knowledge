import { describe, expect, test } from 'vitest';
import { CLEAN_QUIT_SIGNALS, installSignalCleanQuit } from './signal-clean-quit.ts';

interface Rig {
  emit(signal: NodeJS.Signals): void;
  registered: NodeJS.Signals[];
  calls: string[];
  install(overrides?: { markCleanQuit?: () => void }): void;
}

function makeRig(): Rig {
  const handlers = new Map<NodeJS.Signals, Array<() => void>>();
  const registered: NodeJS.Signals[] = [];
  const calls: string[] = [];
  const rig: Rig = {
    registered,
    calls,
    emit(signal) {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
    install(overrides) {
      installSignalCleanQuit({
        process: {
          on(signal, listener) {
            registered.push(signal);
            const list = handlers.get(signal) ?? [];
            list.push(listener);
            handlers.set(signal, list);
            return this;
          },
        },
        markCleanQuit:
          overrides?.markCleanQuit ??
          (() => {
            calls.push('markCleanQuit');
          }),
        quit: () => {
          calls.push('quit');
        },
        logger: { info: () => {} },
      });
    },
  };
  return rig;
}

describe('installSignalCleanQuit', () => {
  test('registers a handler for each of SIGTERM/SIGINT/SIGHUP by default', () => {
    const rig = makeRig();
    rig.install();
    expect(rig.registered).toEqual([...CLEAN_QUIT_SIGNALS]);
    expect([...CLEAN_QUIT_SIGNALS]).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
  });

  test('clears the sentinel before quitting so it is durable against a SIGKILL race', () => {
    const rig = makeRig();
    rig.install();

    rig.emit('SIGTERM');

    expect(rig.calls).toEqual(['markCleanQuit', 'quit']);
  });

  test('each catchable signal drives a clean quit', () => {
    for (const signal of CLEAN_QUIT_SIGNALS) {
      const rig = makeRig();
      rig.install();
      rig.emit(signal);
      expect(rig.calls).toEqual(['markCleanQuit', 'quit']);
    }
  });

  test('fires once — a second signal during teardown is a no-op', () => {
    const rig = makeRig();
    rig.install();

    rig.emit('SIGTERM');
    rig.emit('SIGINT');
    rig.emit('SIGTERM');

    expect(rig.calls).toEqual(['markCleanQuit', 'quit']);
  });

  test('a throwing markCleanQuit still lets the quit proceed', () => {
    const rig = makeRig();
    rig.install({
      markCleanQuit: () => {
        rig.calls.push('markCleanQuit');
        throw new Error('sentinel unwritable');
      },
    });

    expect(() => rig.emit('SIGTERM')).not.toThrow();
    expect(rig.calls).toEqual(['markCleanQuit', 'quit']);
  });
});
