import { beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  buildAndOpenSkill,
  type InstallUserSkillOptions,
  installUserSkill,
  quoteForWindowsShell,
  type SkillInstallLogger,
  type SpawnLike,
} from './skill-install.ts';

async function readServerVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

interface FakeChildScript {
  stderr?: string;
  outcome: { kind: 'exit'; code: number } | { kind: 'error'; error: Error } | { kind: 'hang' };
}

function makeFakeChild(script: FakeChildScript): ReturnType<SpawnLike> {
  const child = new EventEmitter() as unknown as ReturnType<SpawnLike>;
  const stderr = new PassThrough();
  Object.assign(child, {
    stderr,
    stdout: new PassThrough(),
    stdin: null,
    kill: (_sig?: NodeJS.Signals | number) => {
      return true;
    },
  });

  queueMicrotask(() => {
    if (script.stderr) stderr.emit('data', Buffer.from(script.stderr, 'utf-8'));
    if (script.outcome.kind === 'exit') {
      (child as unknown as EventEmitter).emit('exit', script.outcome.code, null);
    } else if (script.outcome.kind === 'error') {
      (child as unknown as EventEmitter).emit('error', script.outcome.error);
    }
  });

  return child;
}

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  opts: SpawnOptions;
}

function makeSpawnFake(script: FakeChildScript): {
  spawn: SpawnLike;
  calls: CapturedSpawn[];
} {
  const calls: CapturedSpawn[] = [];
  const spawn: SpawnLike = (command, args, opts) => {
    calls.push({ command, args, opts });
    return makeFakeChild(script);
  };
  return { spawn, calls };
}

function makeThrowingSpawn(err: Error): { spawn: SpawnLike; calls: CapturedSpawn[] } {
  const calls: CapturedSpawn[] = [];
  const spawn: SpawnLike = (command, args, opts) => {
    calls.push({ command, args, opts });
    throw err;
  };
  return { spawn, calls };
}

interface RecordedLog {
  level: 'warn' | 'info';
  data: unknown;
  message: string;
}

function makeRecordingLogger(): { logger: SkillInstallLogger; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const logger: SkillInstallLogger = {
    warn: (data, message) => records.push({ level: 'warn', data, message }),
    info: (data, message) => records.push({ level: 'info', data, message }),
  };
  return { logger, records };
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-skill-install-'));
}

const YAML_REL = ['.ok', 'skill-state.yml'] as const;
function yamlPathFor(home: string): string {
  return join(home, ...YAML_REL);
}

const CENTRAL_SKILL_REL = ['.agents', 'skills', 'open-knowledge-discovery'] as const;
function centralSkillDirFor(home: string): string {
  return join(home, ...CENTRAL_SKILL_REL);
}

function writeCentralSkill(home: string): void {
  const dir = centralSkillDirFor(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# stub\n', 'utf-8');
}

function findWarn(records: RecordedLog[], event: string): RecordedLog | undefined {
  return records.find((r) => r.level === 'warn' && (r.data as { event?: string }).event === event);
}

function writeLegacyUserSkill(home: string, hostDir = '.claude'): void {
  const dir = join(home, hostDir, 'skills', 'open-knowledge');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# legacy\n', 'utf-8');
}

function writeSidecar(home: string, content: string): void {
  const dir = join(home, '.ok');
  mkdirSync(dir, { recursive: true });
  const trimmed = content.replace(/\n+$/, '');
  const yaml = [
    'schema: 1',
    'targets:',
    '  cli-hosts:',
    `    version: ${JSON.stringify(trimmed)}`,
    `    recordedAt: ${JSON.stringify(new Date().toISOString())}`,
    '',
  ].join('\n');
  writeFileSync(yamlPathFor(home), yaml, 'utf-8');
}

function readSidecarIfExists(home: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(yamlPathFor(home), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const m = raw.match(/cli-hosts:\s*[\r\n]+\s*version:\s*"?([^\n"]+?)"?\s*[\r\n]/);
  if (!m) return null;
  const version = m[1]?.trim() ?? '';
  if (version.length === 0) return null;
  return `${version}\n`;
}

let currentVersion: string;

beforeEach(async () => {
  currentVersion = await readServerVersion();
});

function readInstallEvents(home: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(join(home, '.ok', 'skill-install-events.jsonl'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('quoteForWindowsShell', () => {
  test('quotes whitespace-bearing args, escaping inner double-quotes', () => {
    expect(quoteForWindowsShell('C:\\Users\\John Doe\\skills\\discovery')).toBe(
      '"C:\\Users\\John Doe\\skills\\discovery"',
    );
    expect(quoteForWindowsShell('a "b" c')).toBe('"a \\"b\\" c"');
  });

  test('passes whitespace-free args through untouched (flags + the literal *)', () => {
    expect(quoteForWindowsShell('*')).toBe('*');
    expect(quoteForWindowsShell('--agent')).toBe('--agent');
    expect(quoteForWindowsShell('C:\\Users\\mike\\skills\\discovery')).toBe(
      'C:\\Users\\mike\\skills\\discovery',
    );
  });
});

describe('installUserSkill — Windows npx.cmd shim', () => {
  test('platform "win32" spawns npx with shell:true', async () => {
    const home = freshHome();
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn, platform: 'win32' });

    expect(result).toBe('installed');
    expect(calls[0]?.command).toBe('npx');
    expect(calls[0]?.opts.shell).toBe(true);
    expect(calls[0]?.args).toContain('*');
  });

  test('non-Windows platform spawns without a shell', async () => {
    const home = freshHome();
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    await installUserSkill({ home, spawn, platform: 'linux' });

    expect(calls[0]?.opts.shell ?? false).toBe(false);
  });
});

describe('installUserSkill — fresh install', () => {
  test('no sidecar + subprocess exits 0 → adds discovery, returns "installed"', async () => {
    const home = freshHome();
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe('npx');
    expect(calls[0]?.args).toEqual([
      '-y',
      'skills@~1.5.0',
      'add',
      expect.stringContaining('assets/skills/discovery') as unknown as string,
      '--agent',
      '*',
      '-g',
      '-y',
      '--copy',
    ]);
    expect(calls[0]?.args.some((a) => /assets\/skills\/project/.test(a))).toBe(false);
    expect((calls[0]?.opts.env as NodeJS.ProcessEnv)?.HOME).toBe(home);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
    expect(records.some((r) => r.level === 'info' && /installed/i.test(r.message))).toBe(true);
  });

  test('fresh machine with no legacy dir → npx skills remove is NOT spawned', async () => {
    const home = freshHome();
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    await installUserSkill({ home, spawn });

    expect(calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  test('install event carries bundle: "discovery"', async () => {
    const home = freshHome();
    const { spawn } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    await installUserSkill({ home, spawn });

    const events = readInstallEvents(home);
    const installed = events.find((e) => e.outcome === 'installed');
    expect(installed?.bundle).toBe('discovery');
    expect(installed?.target).toBe('cli-hosts');
  });
});

describe('installUserSkill — legacy migration', () => {
  test('pre-split open-knowledge dir present → npx skills remove runs before the add', async () => {
    const home = freshHome();
    writeLegacyUserSkill(home, '.claude');
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(2);
    expect(calls[0]?.args).toEqual([
      '-y',
      'skills@~1.5.0',
      'remove',
      '--agent',
      '*',
      '-g',
      'open-knowledge',
    ]);
    expect(calls[1]?.args).toContain('add');
  });

  test('legacy remove exiting non-zero is logged + swallowed; install still proceeds', async () => {
    const home = freshHome();
    writeLegacyUserSkill(home, '.cursor');
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 1 } });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('failed');
    expect(calls[0]?.args).toContain('remove');
    expect(findWarn(records, 'skill-install.legacy-remove-failed')).toBeDefined();
  });
});

describe('installUserSkill — idempotency (skip-current)', () => {
  test('sidecar matches current version + central skill present → subprocess NOT invoked, returns "skip-current"', async () => {
    const home = freshHome();
    writeSidecar(home, `${currentVersion}\n`);
    writeCentralSkill(home);
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });

    expect(result).toBe('skip-current');
    expect(calls.length).toBe(0);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
  });

  test('sidecar without trailing newline still matches (tolerant parse)', async () => {
    const home = freshHome();
    writeSidecar(home, currentVersion);
    writeCentralSkill(home);
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });
    expect(result).toBe('skip-current');
    expect(calls.length).toBe(0);
  });

  test('sidecar matches but central skill dir is missing → reinstall fires, sidecar rewritten', async () => {
    const home = freshHome();
    writeSidecar(home, `${currentVersion}\n`);
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(1);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
    const reinstallLog = records.find(
      (r) =>
        r.level === 'info' &&
        (r.data as { event?: string }).event === 'skill-install.reinstall-missing',
    );
    expect(reinstallLog).toBeDefined();
  });
});

describe('installUserSkill — stale sidecar', () => {
  test('sidecar version differs from package version → subprocess invoked, sidecar rewritten', async () => {
    const home = freshHome();
    writeSidecar(home, '0.0.1\n');
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(1);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
  });
});

describe('installUserSkill — failure modes', () => {
  test('subprocess non-zero exit → warning logged, sidecar NOT written, returns "failed"', async () => {
    const home = freshHome();
    const { spawn } = makeSpawnFake({
      stderr: 'no compatible agents detected',
      outcome: { kind: 'exit', code: 1 },
    });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('failed');
    expect(readSidecarIfExists(home)).toBeNull();
    const warnRecord = findWarn(records, 'skill-install.failed');
    expect(warnRecord).toBeDefined();
    expect(warnRecord?.data).toMatchObject({
      event: 'skill-install.failed',
      reason: 'nonzero-exit',
      exitCode: 1,
    });
  });

  test('subprocess hangs past timeout → killed, warning logged, returns "failed"', async () => {
    const home = freshHome();
    const { spawn } = makeSpawnFake({ outcome: { kind: 'hang' } });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn, timeoutMs: 25 });

    expect(result).toBe('failed');
    expect(readSidecarIfExists(home)).toBeNull();
    const warnRecord = findWarn(records, 'skill-install.failed');
    expect(warnRecord?.data).toMatchObject({ event: 'skill-install.failed', reason: 'timeout' });
  });

  test('spawn throws ENOENT (npx missing) → warning logged, returns "failed"', async () => {
    const home = freshHome();
    const enoent = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    const { spawn } = makeThrowingSpawn(enoent);
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('failed');
    expect(readSidecarIfExists(home)).toBeNull();
    const warnRecord = findWarn(records, 'skill-install.failed');
    expect(warnRecord?.data).toMatchObject({
      event: 'skill-install.failed',
      reason: 'spawn-error',
    });
  });

  test('child emits "error" (ENOENT surfaced async) → warning logged, returns "failed"', async () => {
    const home = freshHome();
    const { spawn } = makeSpawnFake({
      outcome: { kind: 'error', error: new Error('spawn ENOENT') },
    });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger, spawn });

    expect(result).toBe('failed');
    expect(readSidecarIfExists(home)).toBeNull();
    const warnRecord = findWarn(records, 'skill-install.failed');
    expect(warnRecord?.data).toMatchObject({
      event: 'skill-install.failed',
      reason: 'spawn-error',
    });
  });
});

describe('installUserSkill — sidecar tolerant parse', () => {
  test('empty sidecar → treated as fresh install, subprocess invoked', async () => {
    const home = freshHome();
    writeSidecar(home, '');
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(1);
  });

  test('malformed sidecar content → treated as fresh install, subprocess invoked', async () => {
    const home = freshHome();
    writeSidecar(home, 'not-a-version-string\n');
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });

    const result = await installUserSkill({ home, spawn });

    expect(result).toBe('installed');
    expect(calls.length).toBe(1);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
  });
});

describe('installUserSkill — HOME propagates to subprocess env', () => {
  test('opts.home is passed as HOME env var to spawn', async () => {
    const home = freshHome();
    const { spawn, calls } = makeSpawnFake({ outcome: { kind: 'exit', code: 0 } });
    const opts: InstallUserSkillOptions = { home, spawn };

    await installUserSkill(opts);

    expect((calls[0]?.opts.env as NodeJS.ProcessEnv)?.HOME).toBe(host(calls).HOME);
  });
});

function host(calls: ReadonlyArray<{ opts: { env?: NodeJS.ProcessEnv } }>): NodeJS.ProcessEnv {
  return (calls[0]?.opts.env ?? {}) as NodeJS.ProcessEnv;
}


describe('buildAndOpenSkill', () => {
  function makeFakeSpawn(capture: {
    command?: string;
    args?: readonly string[];
    threw?: Error;
  }): SpawnLike {
    return ((command: string, args: readonly string[]) => {
      if (capture.threw) throw capture.threw;
      capture.command = command;
      capture.args = args;
      return { unref: () => {} } as ReturnType<SpawnLike>;
    }) as SpawnLike;
  }

  test('--no-open: builds the file and returns status="built" without spawning', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[] } = {};

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'no-open.skill'),
      noOpen: true,
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('built');
    expect(result.outputPath).toBe(join(home, 'no-open.skill'));
    expect(capture.command).toBeUndefined();
    expect(result.handoffError).toBeUndefined();
  });

  test('darwin: spawns `open <path>` and returns status="installed"', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[] } = {};
    const out = join(home, 'darwin.skill');

    const result = await buildAndOpenSkill({
      home,
      out,
      platformName: 'darwin',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('open');
    expect(capture.args).toEqual([out]);
  });

  test('win32: spawns `cmd /c start "" <path>` and returns status="installed"', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[] } = {};
    const out = join(home, 'win32.skill');

    const result = await buildAndOpenSkill({
      home,
      out,
      platformName: 'win32',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('cmd');
    expect(capture.args?.[0]).toBe('/c');
    expect(capture.args?.[1]).toBe('start');
    expect(capture.args?.[3]).toBe(out);
  });

  test('linux: spawns `xdg-open <path>` and returns status="installed"', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[] } = {};

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'linux.skill'),
      platformName: 'linux',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('xdg-open');
  });

  test('unsupported platform: status="built" with handoffError reason=unsupported-platform', async () => {
    const home = freshHome();

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'aix.skill'),
      platformName: 'aix' as NodeJS.Platform,
      spawnFn: makeFakeSpawn({
        threw: new Error('spawn should not have been called'),
      }),
    });

    expect(result.status).toBe('built');
    expect(result.handoffError?.reason).toBe('unsupported-platform');
    expect(result.handoffError?.message).toContain("'aix'");
  });

  test('spawn throws: status="built" with handoffError reason=spawn-error', async () => {
    const home = freshHome();

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'spawn-error.skill'),
      platformName: 'darwin',
      spawnFn: makeFakeSpawn({ threw: new Error('EACCES: permission denied') }),
    });

    expect(result.status).toBe('built');
    expect(result.handoffError?.reason).toBe('spawn-error');
    expect(result.handoffError?.message).toContain('EACCES');
    expect(result.outputPath).toBeDefined();
  });
});


describe('buildAndOpenSkill — install-state gate', () => {
  function makeNoopSpawn(): SpawnLike {
    return ((command: string) => {
      throw new Error(`spawn should not have been called (cmd=${command})`);
    }) as unknown as SpawnLike;
  }
  function writeCoworkState(home: string, version: string): void {
    const dir = join(home, '.ok');
    mkdirSync(dir, { recursive: true });
    const yaml = [
      'schema: 1',
      'targets:',
      '  claude-cowork:',
      `    version: ${JSON.stringify(version)}`,
      `    recordedAt: ${JSON.stringify(new Date().toISOString())}`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'skill-state.yml'), yaml, 'utf-8');
  }
  function readCoworkState(home: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(join(home, '.ok', 'skill-state.yml'), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const m = raw.match(/claude-cowork:\s*[\r\n]+\s*version:\s*"?([^\n"]+?)"?\s*[\r\n]/);
    if (!m) return null;
    const version = m[1]?.trim() ?? '';
    if (version.length === 0) return null;
    return `${version}\n`;
  }

  test('recorded claude-cowork matches current → status="skip-current"; no build, no spawn', async () => {
    const home = freshHome();
    writeCoworkState(home, currentVersion);

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'should-not-build.skill'),
      platformName: 'darwin',
      spawnFn: makeNoopSpawn(),
    });

    expect(result.status).toBe('skip-current');
    expect(result.skillVersion).toBe(currentVersion);
    expect(typeof result.recordedAt).toBe('string');
    let outExists = false;
    try {
      readFileSync(join(home, 'should-not-build.skill'));
      outExists = true;
    } catch {
    }
    expect(outExists).toBe(false);
  });

  test('force=true bypasses gate even when recorded matches', async () => {
    const home = freshHome();
    writeCoworkState(home, currentVersion);
    const capture: { command?: string; args?: readonly string[] } = {};
    const out = join(home, 'forced.skill');

    const result = await buildAndOpenSkill({
      home,
      out,
      platformName: 'darwin',
      spawnFn: ((command: string, args: readonly string[]) => {
        capture.command = command;
        capture.args = args;
        return {
          unref: () => {},
        } as unknown as ReturnType<Parameters<SpawnLike>[2] extends never ? never : SpawnLike>;
      }) as unknown as SpawnLike,
      force: true,
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('open');
  });

  test('successful build writes claude-cowork install-state', async () => {
    const home = freshHome();
    expect(readCoworkState(home)).toBeNull();
    const out = join(home, 'fresh.skill');

    const result = await buildAndOpenSkill({
      home,
      out,
      noOpen: true,
    });

    expect(result.status).toBe('built');
    expect(readCoworkState(home)).toBe(`${currentVersion}\n`);
  });

  test('subsequent invocation after a successful build hits the gate', async () => {
    const home = freshHome();
    const first = await buildAndOpenSkill({
      home,
      out: join(home, 'first.skill'),
      noOpen: true,
    });
    expect(first.status).toBe('built');
    const second = await buildAndOpenSkill({
      home,
      out: join(home, 'second.skill'),
      noOpen: true,
    });
    expect(second.status).toBe('skip-current');
  });
});
