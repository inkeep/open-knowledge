import { delimiter as PATH_DELIMITER } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildOverlaidEnv, runSubprocess } from './subprocess.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];

describe('runSubprocess', () => {
  test('emits one parsed line per NDJSON event from stdout', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`
        console.log(JSON.stringify({type:'a', n:1}));
        console.log(JSON.stringify({type:'b', n:2}));
      `),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    const result = await proc.done;
    expect(result.code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0].parsed).toEqual({ type: 'a', n: 1 });
    expect(lines[1].parsed).toEqual({ type: 'b', n: 2 });
  });

  test('flushes a trailing partial line that lacks a newline terminator', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`process.stdout.write('{"a":1}')`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].parsed).toEqual({ a: 1 });
  });

  test('non-JSON line forwards with parsed:null (caller decides what to do)', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`console.log('hello world')`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).toBe('hello world');
    expect(lines[0].parsed).toBeNull();
  });

  test('captures stderr verbatim and surfaces nonzero exit code', async () => {
    const stderrChunks: Buffer[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`process.stderr.write('boom\\n'); process.exit(7)`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    const result = await proc.done;
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(Buffer.concat(stderrChunks).toString('utf-8')).toContain('boom');
  });

  test('cancel SIGTERMs the child and reports cancelled:true', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 60_000,
      onLine: () => {},
    });
    setTimeout(() => proc.cancel(), 50);
    const result = await proc.done;
    expect(result.cancelled).toBe(true);
    expect(result.code).toBeNull();
  });

  test('cancel is idempotent — calling more than once is safe', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 60_000,
      onLine: () => {},
    });
    proc.cancel();
    proc.cancel();
    proc.cancel();
    const result = await proc.done;
    expect(result.cancelled).toBe(true);
  });

  test('timeout SIGTERMs the child and reports timedOut:true', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli(`setInterval(() => {}, 1000)`),
      trailingArgs: [],
      timeoutMs: 100,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.code).toBeNull();
  });

  test('empty cliArgs returns a clean error result without spawning', async () => {
    const proc = runSubprocess({
      cliArgs: [],
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('no command');
    proc.cancel();
  });

  test('handles a chunked stream that splits a JSON line across writes', async () => {
    const lines: { raw: string; parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`
        process.stdout.write('{"part":');
        setTimeout(() => process.stdout.write('1}\\n'), 30);
      `),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines).toHaveLength(1);
    expect(lines[0].parsed).toEqual({ part: 1 });
  });

  test('blank stdout lines are skipped (not forwarded)', async () => {
    const lines: { raw: string }[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli(`console.log(''); console.log('   '); console.log('keep');`),
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(lines.map((l) => l.raw)).toEqual(['keep']);
  });

  const echoPathCli = fixtureCli(`console.log(JSON.stringify({ path: process.env.PATH }))`);
  const childPathFrom = (lines: { parsed: Record<string, unknown> | null }[]): string =>
    String(lines[0]?.parsed?.path ?? '');

  test('extraPathDirs prepends to the child PATH in order, ahead of the inherited PATH', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      extraPathDirs: ['/opt/one', '/opt/two'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    const childPath = childPathFrom(lines);
    expect(childPath.startsWith(`/opt/one${PATH_DELIMITER}/opt/two${PATH_DELIMITER}`)).toBe(true);
    expect(childPath.endsWith(process.env.PATH ?? '')).toBe(true);
  });

  test('absent extraPathDirs leaves the child PATH untouched', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(childPathFrom(lines)).toBe(process.env.PATH ?? '');
  });

  test('extraPathDirs composes the child PATH from a cliEnv PATH overlay, not the parent PATH', async () => {
    const overlaidPath = `/opt/overlay${PATH_DELIMITER}${process.env.PATH ?? ''}`;
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      cliEnv: { PATH: overlaidPath },
      trailingArgs: [],
      extraPathDirs: ['/opt/one'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    expect(childPathFrom(lines)).toBe(`/opt/one${PATH_DELIMITER}${overlaidPath}`);
  });

  test('extraPathDirs drops empty segments when composing the child PATH', async () => {
    const lines: { parsed: Record<string, unknown> | null }[] = [];
    const proc = runSubprocess({
      cliArgs: echoPathCli,
      trailingArgs: [],
      extraPathDirs: ['', '/opt/only'],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
    });
    await proc.done;
    const childPath = childPathFrom(lines);
    expect(childPath.split(PATH_DELIMITER)[0]).toBe('/opt/only');
  });
});

describe('runSubprocess — cliEnv overlay', () => {
  const printEnvCli = fixtureCli(
    `process.stdout.write(JSON.stringify({ a: process.env.OK_TEST_A ?? null, b: process.env.OK_TEST_B ?? null }))`,
  );

  const withInheritedB = async (run: () => Promise<void>): Promise<void> => {
    const previous = process.env.OK_TEST_B;
    process.env.OK_TEST_B = 'inherited';
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.OK_TEST_B;
      else process.env.OK_TEST_B = previous;
    }
  };

  test('overlay values reach the child and undefined removes an inherited key', async () => {
    await withInheritedB(async () => {
      const lines: { parsed: Record<string, unknown> | null }[] = [];
      const proc = runSubprocess({
        cliArgs: printEnvCli,
        cliEnv: { OK_TEST_A: 'overlay', OK_TEST_B: undefined },
        trailingArgs: [],
        timeoutMs: 5000,
        onLine: (line) => lines.push(line),
      });
      const result = await proc.done;
      expect(result.code).toBe(0);
      expect(lines[0]?.parsed).toEqual({ a: 'overlay', b: null });
    });
  });

  test('no overlay leaves the inherited environment untouched', async () => {
    await withInheritedB(async () => {
      const lines: { parsed: Record<string, unknown> | null }[] = [];
      const proc = runSubprocess({
        cliArgs: printEnvCli,
        trailingArgs: [],
        timeoutMs: 5000,
        onLine: (line) => lines.push(line),
      });
      await proc.done;
      expect(lines[0]?.parsed).toEqual({ a: null, b: 'inherited' });
    });
  });
});

describe('buildOverlaidEnv — case handling across the overlay and the PATH composition', () => {
  const NODE_OPTIONS_VARIANTS = { Node_Options: '--require ./hook.js', node_options: '--inspect' };

  test('win32 deletion removes every inherited casing variant of the key', () => {
    expect(
      buildOverlaidEnv(
        { ...NODE_OPTIONS_VARIANTS },
        { NODE_OPTIONS: undefined },
        undefined,
        'win32',
      ),
    ).toEqual({});
  });

  test('non-win32 deletion leaves differently-cased POSIX variables intact', () => {
    expect(
      buildOverlaidEnv(
        { ...NODE_OPTIONS_VARIANTS },
        { NODE_OPTIONS: undefined },
        undefined,
        'linux',
      ),
    ).toEqual(NODE_OPTIONS_VARIANTS);
  });

  test('win32 assignment replaces a differently-cased inherited key instead of leaving a stale twin', () => {
    expect(
      buildOverlaidEnv({ Ok_Marker: 'inherited' }, { OK_MARKER: 'overlay' }, undefined, 'win32'),
    ).toEqual({ OK_MARKER: 'overlay' });
  });

  test('non-win32 assignment keeps a differently-cased POSIX variable as a distinct entry', () => {
    expect(
      buildOverlaidEnv({ Ok_Marker: 'inherited' }, { OK_MARKER: 'overlay' }, undefined, 'linux'),
    ).toEqual({ Ok_Marker: 'inherited', OK_MARKER: 'overlay' });
  });

  test('win32 extraPathDirs folds an inherited Path into one PATH entry and keeps its value', () => {
    expect(
      buildOverlaidEnv({ Path: 'C:\\Windows\\System32' }, undefined, ['C:\\git\\cmd'], 'win32'),
    ).toEqual({ PATH: 'C:\\git\\cmd;C:\\Windows\\System32' });
  });

  test('non-win32 extraPathDirs reads the exact PATH and leaves a differently-cased Path alone', () => {
    expect(
      buildOverlaidEnv({ Path: '/decoy', PATH: '/usr/bin' }, undefined, ['/opt/one'], 'linux'),
    ).toEqual({ Path: '/decoy', PATH: '/opt/one:/usr/bin' });
  });

  test('extraPathDirs composes from the overlaid PATH, not the base PATH', () => {
    expect(
      buildOverlaidEnv({ PATH: '/base' }, { PATH: '/from/overlay' }, ['/opt/one'], 'linux'),
    ).toEqual({ PATH: '/opt/one:/from/overlay' });
  });

  test('win32 extraPathDirs composes from an overlay PATH that folded an inherited Path away', () => {
    expect(
      buildOverlaidEnv({ Path: '/base' }, { PATH: '/from/overlay' }, ['/opt/one'], 'win32'),
    ).toEqual({ PATH: '/opt/one;/from/overlay' });
  });

  test('extraPathDirs drops empty segments, including an absent base PATH', () => {
    expect(buildOverlaidEnv({}, undefined, ['', '/opt/only'], 'linux')).toEqual({
      PATH: '/opt/only',
    });
  });

  test('the base environment is copied, not mutated', () => {
    const base = { PATH: '/base', Ok_Marker: 'inherited' };
    buildOverlaidEnv(base, { OK_MARKER: 'overlay' }, ['/opt/one'], 'win32');
    expect(base).toEqual({ PATH: '/base', Ok_Marker: 'inherited' });
  });
});

describe('runSubprocess — the win32-folded environment reaches the child', () => {
  const caseVariantsCli = fixtureCli(
    `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() === 'ok_test_case_marker'))))`,
  );

  test('win32 assignment hands the child one folded key, not a stale twin', async () => {
    const previous = process.env.Ok_Test_Case_Marker;
    process.env.Ok_Test_Case_Marker = 'inherited';
    try {
      const lines: { parsed: Record<string, unknown> | null }[] = [];
      const proc = runSubprocess({
        cliArgs: caseVariantsCli,
        cliEnv: { OK_TEST_CASE_MARKER: 'overlay' },
        platform: 'win32',
        trailingArgs: [],
        timeoutMs: 5000,
        onLine: (line) => lines.push(line),
      });
      await proc.done;
      expect(lines[0]?.parsed).toEqual({ OK_TEST_CASE_MARKER: 'overlay' });
    } finally {
      if (previous === undefined) delete process.env.Ok_Test_Case_Marker;
      else process.env.Ok_Test_Case_Marker = previous;
    }
  });

  test.runIf(process.platform !== 'win32')(
    'POSIX: the default platform keeps both inherited casings, so the overlay adds rather than folds',
    async () => {
      const previous = process.env.Ok_Test_Case_Marker;
      process.env.Ok_Test_Case_Marker = 'inherited';
      try {
        const lines: { parsed: Record<string, unknown> | null }[] = [];
        const proc = runSubprocess({
          cliArgs: caseVariantsCli,
          cliEnv: { OK_TEST_CASE_MARKER: 'overlay' },
          trailingArgs: [],
          timeoutMs: 5000,
          onLine: (line) => lines.push(line),
        });
        await proc.done;
        expect(lines[0]?.parsed).toEqual({
          Ok_Test_Case_Marker: 'inherited',
          OK_TEST_CASE_MARKER: 'overlay',
        });
      } finally {
        if (previous === undefined) delete process.env.Ok_Test_Case_Marker;
        else process.env.Ok_Test_Case_Marker = previous;
      }
    },
  );
});

describe('runSubprocess — synchronous spawn failure', () => {
  const NUL_BEARING_ARG = '--marker\u0000injected';

  test('an argument shape spawn() rejects synchronously resolves done with code -1 and the thrown message', async () => {
    const lines: { raw: string }[] = [];
    const stderrChunks: Buffer[] = [];
    const proc = runSubprocess({
      cliArgs: fixtureCli('process.exit(0)'),
      trailingArgs: [NUL_BEARING_ARG],
      timeoutMs: 5000,
      onLine: (line) => lines.push(line),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    const result = await proc.done;
    expect(result).toEqual({
      code: -1,
      stderr: expect.stringContaining('must be a string without null bytes'),
      timedOut: false,
      cancelled: false,
    });
    expect(lines).toEqual([]);
    expect(stderrChunks).toEqual([]);
    expect(() => proc.cancel()).not.toThrow();
  });

  test('the synchronous-throw result is already settled, so no async error event was routed', async () => {
    const ASYNC_ROUTE = Symbol('async-error-event');
    const proc = runSubprocess({
      cliArgs: fixtureCli('process.exit(0)'),
      trailingArgs: [NUL_BEARING_ARG],
      timeoutMs: 5000,
      onLine: () => {},
    });
    const first = await Promise.race([proc.done, Promise.resolve(ASYNC_ROUTE)]);
    expect(first).not.toBe(ASYNC_ROUTE);
    expect(first).toMatchObject({ code: -1 });
  });

  test('the synchronous-throw stderr carries the structured error facts, not just the message', async () => {
    const proc = runSubprocess({
      cliArgs: fixtureCli('process.exit(0)'),
      trailingArgs: [NUL_BEARING_ARG],
      timeoutMs: 5000,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.stderr).toContain('code=ERR_INVALID_ARG_VALUE');
  });

  test('an asynchronous spawn failure reports the same shape with the structured facts', async () => {
    const proc = runSubprocess({
      cliArgs: ['ok-local-op-no-such-binary'],
      trailingArgs: [],
      timeoutMs: 5000,
      onLine: () => {},
    });
    const result = await proc.done;
    expect(result.code).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stderr).toContain('code=ENOENT');
    expect(result.stderr).toContain('syscall=spawn');
  });

  test.runIf(process.platform !== 'win32')(
    'POSIX: a cwd that is a file makes spawn() throw ENOTDIR synchronously',
    async () => {
      const proc = runSubprocess({
        cliArgs: fixtureCli('process.exit(0)'),
        cwd: new URL(import.meta.url).pathname,
        trailingArgs: [],
        timeoutMs: 5000,
        onLine: () => {},
      });
      const result = await proc.done;
      expect(result.code).toBe(-1);
      expect(result.stderr).toMatch(/spawn ENOTDIR/);
      expect(result.timedOut).toBe(false);
      expect(result.cancelled).toBe(false);
      expect(() => proc.cancel()).not.toThrow();
    },
  );
});
