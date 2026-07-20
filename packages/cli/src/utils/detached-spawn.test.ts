import { describe, expect, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { spawnDetachedScrubbed } from './detached-spawn.ts';

describe('spawnDetachedScrubbed', () => {
  interface Captured {
    command?: string;
    args?: readonly string[];
    opts?: SpawnOptions;
  }

  function makeFakeSpawn(captured: Captured, onUnref: () => void) {
    return ((command: string, args: readonly string[], opts: SpawnOptions) => {
      captured.command = command;
      captured.args = args;
      captured.opts = opts;
      return { unref: onUnref };
    }) as unknown as NonNullable<Parameters<typeof spawnDetachedScrubbed>[2]>['spawn'];
  }

  test('spawns detached, stdio:ignore, windowsHide, and unref()s the child', () => {
    const captured: Captured = {};
    let unrefCalled = false;
    spawnDetachedScrubbed('open', ['-b', 'com.example.app'], {
      spawn: makeFakeSpawn(captured, () => {
        unrefCalled = true;
      }),
    });

    expect(captured.command).toBe('open');
    expect(captured.args).toEqual(['-b', 'com.example.app']);
    expect(captured.opts?.detached).toBe(true);
    expect(captured.opts?.stdio).toBe('ignore');
    expect(captured.opts?.windowsHide).toBe(true);
    expect(unrefCalled).toBe(true);
  });

  test('scrubs ELECTRON_RUN_AS_NODE from the child env', () => {
    const captured: Captured = {};
    spawnDetachedScrubbed('open', ['target'], {
      spawn: makeFakeSpawn(captured, () => {}),
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' },
    });

    expect(captured.opts?.env).toBeDefined();
    expect(captured.opts?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(captured.opts?.env?.PATH).toBe('/usr/bin');
  });

  test('defaults env to a scrubbed copy of process.env', () => {
    const prevValue = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const captured: Captured = {};
      spawnDetachedScrubbed('open', ['target'], {
        spawn: makeFakeSpawn(captured, () => {}),
      });

      expect(captured.opts?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
      // The scrub copies — this process keeps its own env untouched.
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1');
    } finally {
      if (prevValue === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prevValue;
    }
  });
});
