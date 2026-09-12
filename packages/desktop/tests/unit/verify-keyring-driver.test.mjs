import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';
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
    const readFile = vi.fn(() =>
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
    const readFile = vi.fn(() => Promise.reject(err));
    const result = await readSmokeResult('/tmp/never-written.json', { readFile });
    expect(result).toBeNull();
  });

  test('propagates non-ENOENT errors', async () => {
    const readFile = vi.fn(() => Promise.reject(new Error('EACCES')));
    await expect(readSmokeResult('/tmp/x.json', { readFile })).rejects.toThrow('EACCES');
  });
});

function fakeSpawn({ exitCode = 0, stderr = '', delayMs = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {});
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
      mkdtemp: vi.fn(async () => '/tmp/ok-fake'),
      rm: vi.fn(async () => {}),
      runCommand: vi.fn(async () => {}),
      cp: vi.fn(async () => {}),
      stat: vi.fn(async () => ({})),
      listAppsInMount: vi.fn(async () => ['OpenKnowledge.app']),
      readFile: vi.fn(() =>
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
      readFile: vi.fn(() =>
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
      timeoutMs: 5,
    });
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(2);
    expect(deps.messages.stderr.join('')).toContain('did not exit within timeout');
  });

  test('exit 3: app exits without writing OUT file', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const deps = fakeDeps({
      readFile: vi.fn(() => Promise.reject(err)),
      spawn: fakeSpawn({ exitCode: 0, stderr: 'dying early\n' }),
    });
    const code = await runDriver(['node', 'script', '/tmp/app.app'], deps);
    expect(code).toBe(3);
    const errOut = deps.messages.stderr.join('');
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
    expect(deps.rm).toHaveBeenCalled();
  });

  test('.dmg input: runs hdiutil attach/detach + copies .app to tmp', async () => {
    const runCommand = vi.fn(async () => {});
    const cp = vi.fn(async () => {});
    const deps = fakeDeps({
      runCommand,
      cp,
      listAppsInMount: vi.fn(async () => ['OpenKnowledge.app']),
    });
    const code = await runDriver(['node', 'script', '/tmp/foo.dmg'], deps);
    expect(code).toBe(0);
    const commandsIssued = runCommand.mock.calls.map((c) => c[0]);
    expect(commandsIssued.filter((c) => c === 'hdiutil').length).toBeGreaterThanOrEqual(2);
    expect(cp).toHaveBeenCalled();
  });

  test('.dmg input with empty mount rejects with driver error', async () => {
    const deps = fakeDeps({
      listAppsInMount: vi.fn(async () => []),
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
    expect(registered.map((r) => r.sig).sort()).toEqual(['SIGINT', 'SIGTERM']);
    expect(removed.map((r) => r.sig).sort()).toEqual(['SIGINT', 'SIGTERM']);
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
    const runCommand = vi.fn(async (cmd) => {
      runCommandCalls += 1;
      if (cmd === 'hdiutil' && runCommandCalls === 1) return;
      if (cmd === 'hdiutil' && runCommandCalls === 2) return;
    });
    const rm = vi.fn(async () => {});
    const deps = fakeDeps({
      process: proc,
      runCommand,
      rm,
      spawn: () => {
        globalThis.setImmediate(() => sigintHandler?.());
        return {
          on: () => {},
          kill: () => {},
          stderr: { on: () => {} },
          stdout: { on: () => {} },
        };
      },
      timeoutMs: 60_000,
    });
    const runPromise = runDriver(['node', 'script', '/tmp/foo.dmg'], deps);
    await setImmediate();
    await setImmediate();
    await setImmediate();

    expect(exits).toEqual([130]);
    expect(rm).toHaveBeenCalled();
    expect(deps.messages.stderr.join('')).toContain('received SIGINT');

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
          sigintHandler?.();
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
    expect(exits).toEqual([130]);
    runPromise.catch(() => {});
  });
});
