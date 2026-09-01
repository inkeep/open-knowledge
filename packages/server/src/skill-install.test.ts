import type { SpawnOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS_WITH_USER_SKILL_DIR } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { BUNDLE_SKILL_NAME } from './skill-bundles.ts';
import {
  buildAndOpenSkill,
  detectUserSkillHosts,
  installUserSkill,
  resolveBuiltinSkillHosts,
  type SkillInstallLogger,
  type SpawnLike,
} from './skill-install.ts';
import { writeBundleDecision } from './skill-state.ts';

async function readServerVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
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

function installHost(home: string, hostDir: string): void {
  mkdirSync(join(home, hostDir), { recursive: true });
}

const ALL_HOST_DIRS = HOSTS_WITH_USER_SKILL_DIR.map((h) => h.hostDir);

function homeEntries(home: string): string[] {
  return readdirSync(home).sort();
}

const YAML_REL = ['.ok', 'skill-state.yml'] as const;
function yamlPathFor(home: string): string {
  return join(home, ...YAML_REL);
}

const CENTRAL_SKILL_REL = ['.agents', 'skills', 'open-knowledge-discovery'] as const;
function centralSkillDirFor(home: string): string {
  return join(home, ...CENTRAL_SKILL_REL);
}

function hostSkillDirFor(home: string, hostDir: string): string {
  return join(home, hostDir, 'skills', 'open-knowledge-discovery');
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

describe('installUserSkill — scope discipline', () => {
  test('no agent host detected → returns "no-hosts" and writes NO skill dirs', async () => {
    const home = freshHome();
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger });

    expect(result).toBe('no-hosts');
    expect(homeEntries(home)).toEqual(['.ok']);
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
    expect(
      records.some((r) => (r.data as { event?: string }).event === 'skill-install.no-hosts'),
    ).toBe(true);
  });

  test('never creates a dotdir for a host that is not installed', async () => {
    const home = freshHome();
    installHost(home, '.claude');

    await installUserSkill({ home });

    expect(homeEntries(home)).toEqual(['.claude', '.ok']);
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
    for (const hostDir of ALL_HOST_DIRS.filter((d) => d !== '.claude')) {
      expect(existsSync(join(home, hostDir))).toBe(false);
    }
  });

  test('writes to every detected host, and only those', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    installHost(home, '.cursor');

    const result = await installUserSkill({ home });

    expect(result).toBe('installed');
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(hostSkillDirFor(home, '.cursor'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(centralSkillDirFor(home), 'SKILL.md'))).toBe(false);
    for (const hostDir of ALL_HOST_DIRS.filter((d) => d !== '.claude' && d !== '.cursor')) {
      expect(existsSync(hostSkillDirFor(home, hostDir))).toBe(false);
    }
  });

  test('"no-hosts" is recorded as skip-current with an explicit reason', async () => {
    const home = freshHome();

    await installUserSkill({ home });

    const events = readInstallEvents(home);
    expect(events.at(-1)?.outcome).toBe('skip-current');
    expect(events.at(-1)?.reason).toBe('no-hosts');
  });

  test('an explicitly declined bundle is never installed, even with a host present', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    await writeBundleDecision(home, BUNDLE_SKILL_NAME.discovery, false);

    const result = await installUserSkill({ home });

    expect(result).toBe('skip-current');
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
    expect(existsSync(hostSkillDirFor(home, '.claude'))).toBe(false);
    expect(readInstallEvents(home).at(-1)?.reason).toBe('declined');
  });

  test('force does not override an explicit decline', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    await writeBundleDecision(home, BUNDLE_SKILL_NAME.discovery, false);

    expect(await installUserSkill({ home, force: true })).toBe('skip-current');
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
  });

  test('an unreadable decision file declines rather than installing', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    mkdirSync(join(home, '.ok', 'skill-state.yml'), { recursive: true });
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger });

    expect(result).toBe('skip-current');
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
    expect(
      records.some(
        (r) => (r.data as { event?: string }).event === 'skill-install.gate.decision-read-failed',
      ),
    ).toBe(true);
  });

  test('no recorded decision still installs', async () => {
    const home = freshHome();
    installHost(home, '.claude');

    expect(await installUserSkill({ home })).toBe('installed');
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(centralSkillDirFor(home), 'SKILL.md'))).toBe(false);
  });

  test('an existing .agents root receives the shared copy', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    installHost(home, '.agents');

    expect(await installUserSkill({ home })).toBe('installed');
    expect(existsSync(join(centralSkillDirFor(home), 'SKILL.md'))).toBe(true);
  });

  test('Pi uses its existing nested user skill root without creating .agents', async () => {
    const home = freshHome();
    installHost(home, '.pi');

    expect(await installUserSkill({ home })).toBe('installed');
    expect(
      existsSync(join(home, '.pi', 'agent', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  test('detectUserSkillHosts reports only the hosts present on disk', () => {
    const home = freshHome();
    expect(detectUserSkillHosts(home)).toEqual([]);
    installHost(home, '.codex');
    expect(detectUserSkillHosts(home).map((h) => h.hostDir)).toEqual(['.codex']);
  });
});

function seedDeclaredRoots(home: string, roots: string[]): void {
  const dir = join(home, '.ok', 'local');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill-placements.json'), JSON.stringify({ roots }));
}

describe('resolveBuiltinSkillHosts', () => {
  test('with no declared roots, resolves only the static hosts present on disk', () => {
    const home = freshHome();
    expect(resolveBuiltinSkillHosts(home)).toEqual([]);
    installHost(home, '.codex');
    expect(resolveBuiltinSkillHosts(home)).toEqual([
      { editor: 'codex', skillsRoot: '.codex/skills', custom: false },
    ]);
  });

  test('includes a declared custom root that exists on disk', () => {
    const home = freshHome();
    seedDeclaredRoots(home, ['.tim/skills']);
    installHost(home, '.tim/skills');
    expect(resolveBuiltinSkillHosts(home)).toContainEqual({
      editor: '.tim/skills',
      skillsRoot: '.tim/skills',
      custom: true,
    });
  });

  test('skips a declared custom root that no longer exists on disk', () => {
    const home = freshHome();
    seedDeclaredRoots(home, ['.tim/skills']);
    expect(resolveBuiltinSkillHosts(home).some((host) => host.custom)).toBe(false);
  });

  test('a declared root duplicating a static host appears once', () => {
    const home = freshHome();
    installHost(home, '.codex');
    seedDeclaredRoots(home, ['.codex/skills']);
    installHost(home, '.codex/skills');
    expect(
      resolveBuiltinSkillHosts(home).filter((host) => host.skillsRoot === '.codex/skills'),
    ).toEqual([{ editor: 'codex', skillsRoot: '.codex/skills', custom: false }]);
  });

  test('an unreadable placements ledger degrades to the static hosts only', () => {
    const home = freshHome();
    installHost(home, '.codex');
    mkdirSync(join(home, '.ok', 'local'), { recursive: true });
    writeFileSync(join(home, '.ok', 'local', 'skill-placements.json'), '{ not json');
    expect(resolveBuiltinSkillHosts(home)).toEqual([
      { editor: 'codex', skillsRoot: '.codex/skills', custom: false },
    ]);
  });
});

describe('installUserSkill — fresh install', () => {
  test('no sidecar + a detected host → writes the bundle, returns "installed"', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    const { logger, records } = makeRecordingLogger();

    const result = await installUserSkill({ home, logger });

    expect(result).toBe('installed');
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
    const installed = records.find(
      (r) => (r.data as { event?: string }).event === 'skill-install.installed',
    );
    expect(installed?.message).toContain(hostSkillDirFor(home, '.claude'));
  });

  test('install event carries bundle: "discovery"', async () => {
    const home = freshHome();
    installHost(home, '.claude');

    await installUserSkill({ home });

    const events = readInstallEvents(home);
    expect(events.at(-1)?.bundle).toBe('discovery');
    expect(events.at(-1)?.outcome).toBe('installed');
  });

  test('a shrinking bundle leaves no orphaned files from a prior version', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    const dest = hostSkillDirFor(home, '.claude');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'STALE.md'), '# from an older bundle\n', 'utf-8');

    await installUserSkill({ home });

    expect(existsSync(join(dest, 'STALE.md'))).toBe(false);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });
});

describe('installUserSkill — legacy migration', () => {
  test('pre-split open-knowledge dir is removed before the discovery bundle lands', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeLegacyUserSkill(home, '.claude');

    const result = await installUserSkill({ home });

    expect(result).toBe('installed');
    expect(existsSync(join(home, '.claude', 'skills', 'open-knowledge'))).toBe(false);
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
  });

  test('a pre-split dir in the central store is swept too', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeLegacyUserSkill(home, '.agents');

    await installUserSkill({ home });

    expect(existsSync(join(home, '.agents', 'skills', 'open-knowledge'))).toBe(false);
  });

  test('fresh machine with no legacy dir → migration is a no-op', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    const { logger, records } = makeRecordingLogger();

    await installUserSkill({ home, logger });

    expect(findWarn(records, 'skill-install.legacy-remove-failed')).toBeUndefined();
  });
});

describe('installUserSkill — idempotency (skip-current)', () => {
  test('sidecar matches current version + central skill present → returns "skip-current"', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, currentVersion);
    writeCentralSkill(home);

    const result = await installUserSkill({ home });

    expect(result).toBe('skip-current');
    expect(existsSync(hostSkillDirFor(home, '.claude'))).toBe(false);
  });

  test('force bypasses the skip-current gate', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, currentVersion);
    writeCentralSkill(home);

    const result = await installUserSkill({ home, force: true });

    expect(result).toBe('installed');
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
  });

  test('a concrete-host-only install is current on the next run', async () => {
    const home = freshHome();
    installHost(home, '.claude');

    expect(await installUserSkill({ home })).toBe('installed');
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
    expect(await installUserSkill({ home })).toBe('skip-current');
  });

  test('sidecar without trailing newline still matches (tolerant parse)', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, currentVersion);
    writeCentralSkill(home);

    expect(await installUserSkill({ home })).toBe('skip-current');
  });

  test('sidecar matches but the existing host skill is missing → reinstall fires', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, currentVersion);

    const result = await installUserSkill({ home });

    expect(result).toBe('installed');
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
    expect(existsSync(centralSkillDirFor(home))).toBe(false);
  });

  test('an existing central host + matching sidecar still skips', async () => {
    const home = freshHome();
    writeSidecar(home, currentVersion);
    writeCentralSkill(home);

    expect(await installUserSkill({ home })).toBe('skip-current');
  });
});

describe('installUserSkill — stale sidecar', () => {
  test('sidecar version differs from package version → reinstall, sidecar rewritten', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, '0.0.1-stale');
    writeCentralSkill(home);

    const result = await installUserSkill({ home });

    expect(result).toBe('installed');
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
  });

  test('empty sidecar → treated as fresh install', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    writeSidecar(home, '');

    expect(await installUserSkill({ home })).toBe('installed');
  });

  test('malformed sidecar content → treated as fresh install', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(yamlPathFor(home), 'not: [valid', 'utf-8');

    expect(await installUserSkill({ home })).toBe('installed');
  });
});

describe('installUserSkill — failure modes', () => {
  test('every destination write failing → warning logged, sidecar NOT written, returns "failed"', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    const { logger, records } = makeRecordingLogger();

    writeFileSync(join(home, '.agents'), 'not a dir\n', 'utf-8');
    writeFileSync(join(home, '.claude', 'skills'), 'not a dir\n', 'utf-8');

    const result = await installUserSkill({ home, logger });

    expect(result).toBe('failed');
    expect(readSidecarIfExists(home)).toBeNull();
    expect(findWarn(records, 'skill-install.failed')).toBeDefined();
  });

  test('a partial failure still installs the survivors and records the version', async () => {
    const home = freshHome();
    installHost(home, '.claude');
    installHost(home, '.cursor');
    const { logger, records } = makeRecordingLogger();

    writeFileSync(join(home, '.cursor', 'skills'), 'not a dir\n', 'utf-8');

    const result = await installUserSkill({ home, logger });

    expect(result).toBe('installed');
    expect(existsSync(join(hostSkillDirFor(home, '.claude'), 'SKILL.md'))).toBe(true);
    expect(readSidecarIfExists(home)).toBe(`${currentVersion}\n`);
    expect(
      records.some((r) => (r.data as { event?: string }).event === 'skill-install.partial'),
    ).toBe(true);
  });
});

describe('buildAndOpenSkill', () => {
  function makeFakeSpawn(capture: {
    command?: string;
    args?: readonly string[];
    opts?: SpawnOptions;
    threw?: Error;
  }): SpawnLike {
    return ((command: string, args: readonly string[], opts: SpawnOptions) => {
      if (capture.threw) throw capture.threw;
      capture.command = command;
      capture.args = args;
      capture.opts = opts;
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
    const capture: { command?: string; args?: readonly string[]; opts?: SpawnOptions } = {};
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
    expect(capture.opts?.windowsHide).toBe(true);
  });

  test('win32: spawns `cmd /c start "" <path>` and returns status="installed"', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[]; opts?: SpawnOptions } = {};
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
    expect(capture.opts?.windowsHide).toBe(true);
  });

  test('linux: spawns `xdg-open <path>` and returns status="installed"', async () => {
    const home = freshHome();
    const capture: { command?: string; args?: readonly string[]; opts?: SpawnOptions } = {};

    const result = await buildAndOpenSkill({
      home,
      out: join(home, 'linux.skill'),
      platformName: 'linux',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('xdg-open');
    expect(capture.opts?.windowsHide).toBe(true);
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
    } catch {}
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

describe('installUserSkill — home guard', () => {
  test.each([
    '',
    '.',
    'relative/home',
  ])('a non-absolute home (%j) fails without writing anything', async (bogus) => {
    const { logger, records } = makeRecordingLogger();
    expect(await installUserSkill({ home: bogus, logger })).toBe('failed');
    expect(findWarn(records, 'skill-install.failed')?.data).toMatchObject({
      reason: 'home-not-absolute',
    });
    expect(existsSync(join(process.cwd(), bogus, '.ok'))).toBe(false);
  });

  test('a relative home cannot touch a matching tree in the cwd', async () => {
    const box = freshHome();
    const decoy = join(box, '.claude', 'skills', 'open-knowledge-discovery');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'SKILL.md'), '# mine\n', 'utf-8');
    const prev = process.cwd();
    process.chdir(box);
    try {
      expect(await installUserSkill({ home: '' })).toBe('failed');
      expect(existsSync(join(decoy, 'SKILL.md'))).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });
});
