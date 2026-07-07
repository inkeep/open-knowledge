import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import {
  classifyInputPath,
  parseArgs,
  readSmokeResult,
  runDriver,
} from '../../../../scripts/verify-keyring-in-packaged-dmg.mjs';

describe('parseArgs', () => {
  test('accepts a single positional', () => {
    const args = parseArgs(['node', 'script', '/Applications/OpenKnowledge.app']);
    expect(args.inputPath).toBe('/Applications/OpenKnowledge.app');
  });

  test('rejects zero positionals', () => {
    expect(() => parseArgs(['node', 'script'])).toThrow(/Usage:/);
  });

  test('rejects multiple positionals', () => {
    expect(() => parseArgs(['node', 'script', 'a', 'b'])).toThrow(/Usage:/);
  });
});

describe('classifyInputPath', () => {
  test('recognises .dmg', () => {
    expect(classifyInputPath('/tmp/foo.dmg')).toBe('dmg');
    expect(classifyInputPath('/tmp/Foo.DMG')).toBe('dmg');
  });

  test('recognises .app', () => {
    expect(classifyInputPath('/Applications/Foo.app')).toBe('app');
    expect(classifyInputPath('/tmp/Foo.APP')).toBe('app');
  });

  test('rejects other extensions', () => {
    expect(() => classifyInputPath('/tmp/foo.zip')).toThrow(/must be a .dmg or .app/);
  });
});

describe('readSmokeResult', () => {
  test('returns parsed JSON on success', async () => {
    const readFile = mock(() =>
      Promise.resolve('{"ok":true,"backend":"keyring","timestamp":"2026-04-21T00:00:00Z"}'),
    );
    const result = await readSmokeResult('/tmp/smoke.json', { readFile });
    expect(result).toEqual({
      ok: true,
      backend: 'keyring',
      timestamp: '2026-04-21T00:00:00Z',
    });
  });

  test('returns null on ENOENT', async () => {
    const err = Object.assign(new Error('file missing'), { code: 'ENOENT' });
    const readFile = mock(() => Promise.reject(err));
    const result = await readSmokeResult('/tmp/never-written.json', { readFile });
    expect(result).toBeNull();
  });

  test('propagates non-ENOENT errors', async () => {
    const readFile = mock(() => Promise.reject(new Error('EACCES')));
    await expect(readSmokeResult('/tmp/x.json', { readFile })).rejects.toThrow('EACCES');
  });
});

/**
 * Build a fake child-process that exits synchronously with configured
 * exit code + stderr. The `spawn` deps-injection lets us drive the driver
 * without an actual Electron binary.
 */
function fakeSpawn({ exitCode = 0, stderr = '', delayMs = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = mock(() => {});
    setTimeout(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf-8'));
      if (exitCode !== null) child.emit('exit', exitCode);
    }, delayMs);
    return child;
  };
}

describe('runDriver (full orchestration)', () => {
  function fakeDeps(overrides = {}) {
    const messages = { stdout: [], stderr: [] };
    return {
      writeStream: (s) => messages.stdout.push(s),
      errStream: (s) => messages.stderr.push(s),
      mkdtemp: mock(async () => '/tmp/ok-fake'),
      rm: mock(async () => {}),
      runCommand: mock(async () => {}),
      cp: mock(async () => {}),
      stat: mock(async () => ({})),
      listAppsInMount: mock(async () => ['OpenKnowledge.app']),
      readFile: mock(() =>
        Promise.resolve('{"ok":true,"backend":"keyring","durationMs":5,"timestamp":"t"}'),
      ),
      spawn: fakeSpawn({ exitCode: 0 }),
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h),
      ...overrides,
      messages,
    };
  }

  test('exit 0: ok:true result printed as green summary', async () => {
    const deps = fakeDeps();
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(0);
    expect(deps.messages.stdout.join('')).toContain('OK');
    expect(deps.messages.stdout.join('')).toContain('keyring');
  });

  test('exit 1: ok:false result prints error + stderr tail', async () => {
    const deps = fakeDeps({
      readFile: mock(() =>
        Promise.resolve('{"ok":false,"error":"module not found","timestamp":"t"}'),
      ),
      spawn: fakeSpawn({ exitCode: 1, stderr: 'fatal: dlopen failed\n' }),
    });
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(1);
    const errOut = deps.messages.stderr.join('');
    expect(errOut).toContain('module not found');
    expect(errOut).toContain('dlopen failed');
  });

  test('exit 2: timeout kills child + surfaces stderr tail', async () => {
    const deps = fakeDeps({
      spawn: fakeSpawn({ exitCode: null, delayMs: 10 }),
      // Short injected timeout
      timeoutMs: 5,
    });
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(2);
    expect(deps.messages.stderr.join('')).toContain('did not exit within timeout');
  });

  test('exit 3: app exits without writing OUT file', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const deps = fakeDeps({
      readFile: mock(() => Promise.reject(err)),
      spawn: fakeSpawn({ exitCode: 0, stderr: 'dying early\n' }),
    });
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(3);
    const errOut = deps.messages.stderr.join('');
    // Exit-3 stderr must name BOTH shapes collapsed into this branch —
    // "exited before the smoke finished" (pre-smoke crash) and "output write
    // failed" (smoke ran but writeSmokeResult threw).
    expect(errOut).toContain('exited before the smoke finished');
    expect(errOut).toContain('output write failed');
    expect(errOut).toContain('dying early');
  });

  test('exit 2: bad argv', async () => {
    const deps = fakeDeps();
    const code = await runDriver(['node', 'script'], deps);
    expect(code).toBe(2);
    expect(deps.messages.stderr.join('')).toContain('Usage:');
  });

  test('cleanup runs on every exit path (rm called for outDir)', async () => {
    const deps = fakeDeps();
    await runDriver(['node', 'script', '/tmp/app.app'], deps);
    // outDir cleanup always runs
    expect(deps.rm).toHaveBeenCalled();
  });

  test('.dmg input: runs hdiutil attach/detach + copies .app to tmp', async () => {
    const runCommand = mock(async () => {});
    const cp = mock(async () => {});
    const deps = fakeDeps({
      runCommand,
      cp,
      listAppsInMount: mock(async () => ['OpenKnowledge.app']),
    });
    const code = await runDriver(['node', 'script', '/tmp/foo.dmg'], deps);
    expect(code).toBe(0);
    const commandsIssued = runCommand.mock.calls.map((c) => c[0]);
    expect(commandsIssued.filter((c) => c === 'hdiutil').length).toBeGreaterThanOrEqual(2);
    expect(cp).toHaveBeenCalled();
  });

  test('.dmg input with empty mount rejects with driver error', async () => {
    const deps = fakeDeps({
      listAppsInMount: mock(async () => []),
    });
    const code = await runDriver(['node', 'script', '/tmp/empty.dmg'], deps);
    expect(code).toBe(1);
    expect(deps.messages.stderr.join('')).toContain('No .app bundle found');
  });

  test('signal handlers registered during run, removed on clean exit', async () => {
    const registered = [];
    const removed = [];
    const proc = {
      once: (sig, cb) => registered.push({ sig, cb }),
      removeListener: (sig, cb) => removed.push({ sig, cb }),
      exit: () => {
        throw new Error('unexpected exit call on clean path');
      },
    };
    const deps = fakeDeps({ process: proc });
    await runDriver(['node', 'script', '/tmp/app.app'], deps);
    // Both signals registered at run entry
    expect(registered.map((r) => r.sig).sort()).toEqual(['SIGINT', 'SIGTERM']);
    // Both removed on finally — no listener-count leak across repeated runs
    expect(removed.map((r) => r.sig).sort()).toEqual(['SIGINT', 'SIGTERM']);
    // Same handler refs registered + removed (correctness of cleanup)
    for (const reg of registered) {
      const match = removed.find((r) => r.sig === reg.sig && r.cb === reg.cb);
      expect(match).toBeDefined();
    }
  });

  test('SIGINT fires cleanup (rm + resolvedApp.cleanup) then exits 130', async () => {
    let sigintHandler;
    const exits = [];
    const proc = {
      once: (sig, cb) => {
        if (sig === 'SIGINT') sigintHandler = cb;
      },
      removeListener: () => {},
      exit: (code) => exits.push(code),
    };
    let runCommandCalls = 0;
    const runCommand = mock(async (cmd) => {
      runCommandCalls += 1;
      // Simulate .dmg path so resolvedApp.cleanup has work to do (detach)
      if (cmd === 'hdiutil' && runCommandCalls === 1) return; // attach
      if (cmd === 'hdiutil' && runCommandCalls === 2) return; // detach (normal finally)
    });
    const rm = mock(async () => {});
    const deps = fakeDeps({
      process: proc,
      runCommand,
      rm,
      // Inject a spawn that never exits so we can fire SIGINT before normal finally
      spawn: () => {
        // Fire SIGINT synchronously after spawn "starts"
        globalThis.setImmediate(() => sigintHandler?.());
        return {
          on: () => {},
          kill: () => {},
          stderr: { on: () => {} },
          stdout: { on: () => {} },
        };
      },
      // Keep the run from timing out normally — test controls termination via SIGINT.
      timeoutMs: 60_000,
    });
    // Don't await — runDriver's promise will never resolve because we're
    // simulating signal-driven exit. Fire SIGINT via setImmediate above.
    const runPromise = runDriver(['node', 'script', '/tmp/foo.dmg'], deps);
    // Let the event loop drain so the setImmediate + signal cleanup runs
    await setImmediate();
    await setImmediate();
    await setImmediate();

    expect(exits).toEqual([130]);
    expect(rm).toHaveBeenCalled();
    // Cleanup message surfaced
    expect(deps.messages.stderr.join('')).toContain('received SIGINT');

    // Prevent the dangling runPromise from causing an unhandled rejection —
    // we deliberately short-circuited runDriver before it could resolve.
    runPromise.catch(() => {});
  });

  test('SIGTERM exits 143', async () => {
    let sigtermHandler;
    const exits = [];
    const proc = {
      once: (sig, cb) => {
        if (sig === 'SIGTERM') sigtermHandler = cb;
      },
      removeListener: () => {},
      exit: (code) => exits.push(code),
    };
    const deps = fakeDeps({
      process: proc,
      spawn: () => {
        globalThis.setImmediate(() => sigtermHandler?.());
        return {
          on: () => {},
          kill: () => {},
          stderr: { on: () => {} },
          stdout: { on: () => {} },
        };
      },
      timeoutMs: 60_000,
    });
    const runPromise = runDriver(['node', 'script', '/tmp/app.app'], deps);
    await setImmediate();
    await setImmediate();
    expect(exits).toEqual([143]);
    expect(deps.messages.stderr.join('')).toContain('received SIGTERM');
    runPromise.catch(() => {});
  });

  test('signal handler is idempotent — double-fire exits once', async () => {
    let sigintHandler;
    const exits = [];
    const proc = {
      once: (sig, cb) => {
        if (sig === 'SIGINT') sigintHandler = cb;
      },
      removeListener: () => {},
      exit: (code) => exits.push(code),
    };
    const deps = fakeDeps({
      process: proc,
      spawn: () => {
        globalThis.setImmediate(() => {
          sigintHandler?.();
          sigintHandler?.(); // second fire — guarded by signalHandled
        });
        return {
          on: () => {},
          kill: () => {},
          stderr: { on: () => {} },
          stdout: { on: () => {} },
        };
      },
      timeoutMs: 60_000,
    });
    const runPromise = runDriver(['node', 'script', '/tmp/app.app'], deps);
    await setImmediate();
    await setImmediate();
    expect(exits).toEqual([130]); // single exit despite two signal fires
    runPromise.catch(() => {});
  });
});
