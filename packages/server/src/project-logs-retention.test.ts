import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_AUTHORITY_LEASES_DIRNAME, SPAWN_ERROR_LOG } from '@inkeep/open-knowledge-core';
import { okProjectLogsDir, openSpawnErrorLog } from '@inkeep/open-knowledge-core/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fsTraced from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { prepareProjectLogsDir, prepareSpawnProjectLogsDir } from './project-logs-retention.ts';
import * as authority from './server-authority.ts';
import { acquireServerAuthority, ServerAuthorityRegistryError } from './server-authority.ts';
import * as authorityLeases from './server-authority-lease.ts';
import { canonicalContentPath } from './server-content-policy.ts';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

let root: string;
let home: string;
let registryPath: string;
const releases: Array<() => void> = [];
const eightDaysAgo = (): Date => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ok-project-log-retention-')));
  home = join(root, 'home');
  registryPath = join(root, 'authority', 'registry.sqlite');
  const projectDir = project('registry-init');
  const handle = acquireServerAuthority({
    scope: { kind: 'tree', path: projectDir, excluded: [] },
    projectDir,
    serverInstanceId: randomUUID(),
    registryPath,
  });
  handle.release();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  rmSync(root, { recursive: true, force: true });
});

function project(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function oldNamespace(projectDir: string): string {
  const path = okProjectLogsDir(projectDir, home);
  mkdirSync(path, { recursive: true });
  const file = join(path, 'server-current.jsonl');
  writeFileSync(file, 'retained diagnostic\n');
  const old = eightDaysAgo();
  utimesSync(file, old, old);
  utimesSync(path, old, old);
  return path;
}

function prepare(projectDir = project('current')): string {
  return prepareProjectLogsDir(projectDir, { home, authorityRegistryPath: registryPath });
}

function observeRegistryLockDuringTouch(path: string): boolean[] {
  const observations: boolean[] = [];
  const original = fsTraced.tracedUtimesSync;
  vi.spyOn(fsTraced, 'tracedUtimesSync').mockImplementation((...args) => {
    const contender = new DatabaseSync(path, { timeout: 0 });
    try {
      try {
        contender.exec('BEGIN IMMEDIATE');
        observations.push(false);
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        observations.push(typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6));
      }
    } finally {
      contender.close();
    }
    return original(...args);
  });
  return observations;
}

test('reclaims old inactive namespaces after their project is removed and keeps recent evidence', () => {
  const removed = project('removed');
  const old = oldNamespace(removed);
  rmSync(removed, { recursive: true });
  const recent = oldNamespace(project('recent'));
  writeFileSync(join(recent, SPAWN_ERROR_LOG), 'recent failure\n');
  prepare();
  expect(existsSync(old)).toBe(false);
  expect(readFileSync(join(recent, SPAWN_ERROR_LOG), 'utf8')).toBe('recent failure\n');
});

test('preserves arbitrarily quiet active authority even when every log timestamp is old', () => {
  const projectDir = project('quiet');
  const path = oldNamespace(projectDir);
  const handle = acquireServerAuthority({
    scope: { kind: 'tree', path: projectDir, excluded: [] },
    projectDir,
    serverInstanceId: randomUUID(),
    registryPath,
  });
  releases.push(handle.release);
  prepare();
  expect(readFileSync(join(path, 'server-current.jsonl'), 'utf8')).toBe('retained diagnostic\n');
  handle.release();
  prepare();
  expect(existsSync(path)).toBe(false);
});

test('a held canonical authority protects logs after its aliased ephemeral project is removed', () => {
  const realParent = project('real-parent');
  const aliasParent = join(root, 'aliased-parent');
  symlinkSync(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  const logicalProject = join(aliasParent, 'ephemeral-project');
  mkdirSync(logicalProject);
  const path = oldNamespace(logicalProject);
  const canonicalProject = canonicalContentPath(logicalProject);
  const handle = acquireServerAuthority({
    scope: { kind: 'tree', path: canonicalProject, excluded: [] },
    projectDir: canonicalProject,
    serverInstanceId: randomUUID(),
    registryPath,
  });
  releases.push(handle.release);
  rmSync(logicalProject, { recursive: true });
  expect(okProjectLogsDir(logicalProject, home)).not.toBe(path);
  prepare();
  expect(readFileSync(join(path, 'server-current.jsonl'), 'utf8')).toBe('retained diagnostic\n');
  handle.release();
  prepare();
  expect(existsSync(path)).toBe(false);
});

test.each(['sqlite-lifetime-lease:v1', 'future-protocol:v2'])(
  'an unverifiable lease (%s) prepares under the transaction but skips cleanup',
  (protocol) => {
    const path = oldNamespace(project('stale'));
    const database = new DatabaseSync(registryPath);
    database
      .prepare('INSERT INTO server_authority VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        randomUUID(),
        randomUUID(),
        process.pid,
        protocol,
        project('unverifiable'),
        JSON.stringify({ kind: 'tree', path: root, excluded: [] }),
        new Date().toISOString(),
      );
    database.close();
    const observations = observeRegistryLockDuringTouch(registryPath);
    const current = prepare();
    expect(observations).toEqual([true]);
    expect(existsSync(path)).toBe(true);
    const fd = openSpawnErrorLog(join(current, SPAWN_ERROR_LOG), process.pid);
    try {
      writeSync(fd, 'new diagnostic survives\n');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(join(current, SPAWN_ERROR_LOG), 'utf8')).toContain(
      'new diagnostic survives',
    );
  },
);

test('an unlocked persisted lifetime lease permits old orphan namespace reclamation', () => {
  const projectDir = project('crashed');
  const path = oldNamespace(projectDir);
  const token = randomUUID();
  const leaseDir = join(root, 'authority', SERVER_AUTHORITY_LEASES_DIRNAME);
  mkdirSync(leaseDir, { recursive: true });
  const lease = new DatabaseSync(join(leaseDir, `${token}.sqlite`));
  lease.exec('CREATE TABLE lease (owner_token TEXT PRIMARY KEY) STRICT');
  lease.prepare('INSERT INTO lease VALUES (?)').run(token);
  lease.close();
  const registry = new DatabaseSync(registryPath);
  registry
    .prepare('INSERT INTO server_authority VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      randomUUID(),
      token,
      process.pid,
      'sqlite-lifetime-lease:v1',
      projectDir,
      JSON.stringify({ kind: 'tree', path: projectDir, excluded: [] }),
      new Date().toISOString(),
    );
  registry.close();
  prepare();
  expect(existsSync(path)).toBe(false);
});

test('an ownership lease access error skips cleanup without dropping new logging', () => {
  const old = oldNamespace(project('old-access-denied'));
  const holderProject = project('holder-access-denied');
  const handle = acquireServerAuthority({
    scope: { kind: 'tree', path: holderProject, excluded: [] },
    projectDir: holderProject,
    serverInstanceId: randomUUID(),
    registryPath,
  });
  releases.push(handle.release);
  vi.spyOn(authorityLeases, 'isServerAuthorityLeaseReleased').mockImplementationOnce(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  const observations = observeRegistryLockDuringTouch(registryPath);
  const current = prepare();
  expect(observations).toEqual([true]);
  expect(existsSync(old)).toBe(true);
  writeFileSync(join(current, 'server-current.jsonl'), 'still logging\n');
  expect(readFileSync(join(current, 'server-current.jsonl'), 'utf8')).toBe('still logging\n');
});

test('an unreadable registry aborts preparation without touching an unguarded namespace', () => {
  const old = oldNamespace(project('old-registry-access-denied'));
  const projectDir = project('new-registry-access-denied');
  const current = okProjectLogsDir(projectDir, home);
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  expect(() => prepare(projectDir)).toThrow(ServerAuthorityRegistryError);
  expect(existsSync(old)).toBe(true);
  expect(existsSync(current)).toBe(false);
});

test.each([5, 6, 261])(
  'ownership contention (%i) aborts preparation without an unguarded fallback',
  (errcode) => {
    const old = oldNamespace(project('old-contended'));
    const projectDir = project('new-contended');
    const current = okProjectLogsDir(projectDir, home);
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => {
      throw Object.assign(new Error('Database is busy'), { errcode });
    });
    expect(() => prepare(projectDir)).toThrow(ServerAuthorityRegistryError);
    expect(existsSync(current)).toBe(false);
    expect(existsSync(old)).toBe(true);
  },
);

test('a missing registry is initialized before namespace refresh and pruning', () => {
  const old = oldNamespace(project('old'));
  const missingRegistry = join(root, 'missing', 'registry.sqlite');
  const observations = observeRegistryLockDuringTouch(missingRegistry);
  const current = prepareProjectLogsDir(project('new'), {
    home,
    authorityRegistryPath: missingRegistry,
  });
  expect(observations).toEqual([true]);
  expect(existsSync(old)).toBe(false);
  const registry = new DatabaseSync(missingRegistry, { readOnly: true });
  try {
    expect(registry.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(registry.prepare('SELECT count(*) AS count FROM server_authority').get()?.count).toBe(0);
  } finally {
    registry.close();
  }
  writeFileSync(join(current, 'server-current.jsonl'), 'still logging\n');
  expect(readFileSync(join(current, 'server-current.jsonl'), 'utf8')).toBe('still logging\n');
});

test('an unavailable registry location aborts without an unguarded preparation', () => {
  const old = oldNamespace(project('old-location-unavailable'));
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'ordinary fixture file');
  const projectDir = project('new-location-unavailable');
  const current = okProjectLogsDir(projectDir, home);
  expect(() =>
    prepareProjectLogsDir(projectDir, {
      home,
      authorityRegistryPath: join(blocked, 'registry.sqlite'),
    }),
  ).toThrow(ServerAuthorityRegistryError);
  expect(existsSync(old)).toBe(true);
  expect(existsSync(current)).toBe(false);
});

test('an optional namespace preparation failure leaves boot logging best-effort and skips pruning', () => {
  const old = oldNamespace(project('old-preparation-failed'));
  const projectDir = project('preparation-failed');
  const current = okProjectLogsDir(projectDir, home);
  const original = fsTraced.tracedMkdirSync;
  vi.spyOn(fsTraced, 'tracedMkdirSync').mockImplementation((path, options) => {
    if (path === current) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return original(path, options);
  });
  expect(prepare(projectDir)).toBe(current);
  expect(existsSync(old)).toBe(true);
  expect(existsSync(current)).toBe(false);
});

test('a namespace pruning error stays best-effort rather than becoming an authority failure', () => {
  const old = oldNamespace(project('old-pruning-failed'));
  vi.spyOn(fsTraced, 'tracedRmSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  const current = prepare();
  expect(existsSync(old)).toBe(true);
  writeFileSync(join(current, 'server-current.jsonl'), 'logging continues\n');
  expect(readFileSync(join(current, 'server-current.jsonl'), 'utf8')).toBe('logging continues\n');
});

test('preparing a new attempt refreshes its namespace under the real SQLite transaction', () => {
  const projectDir = project('attempt');
  const path = oldNamespace(projectDir);
  const observations = observeRegistryLockDuringTouch(registryPath);
  expect(prepare(projectDir)).toBe(path);
  expect(observations).toEqual([true]);
  expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
  vi.restoreAllMocks();
  prepare(project('other'));
  const fd = openSpawnErrorLog(join(path, SPAWN_ERROR_LOG), process.pid);
  try {
    writeSync(fd, 'late startup stderr\n');
  } finally {
    closeSync(fd);
  }
  expect(readFileSync(join(path, SPAWN_ERROR_LOG), 'utf8')).toContain('late startup stderr');
});

test('preserves symlinked namespaces and unknown contents rather than following or removing them', () => {
  const target = join(root, 'external-diagnostics');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'server-current.jsonl'), 'external diagnostic\n');
  const aliasProject = project('alias');
  const alias = okProjectLogsDir(aliasProject, home);
  mkdirSync(join(alias, '..'), { recursive: true });
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const unknown = oldNamespace(project('unknown'));
  writeFileSync(join(unknown, 'not-an-ok-diagnostic.txt'), 'do not remove');
  const old = eightDaysAgo();
  utimesSync(unknown, old, old);
  utimesSync(join(target, 'server-current.jsonl'), old, old);
  utimesSync(target, old, old);
  prepare();
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(alias, 'server-current.jsonl'), 'utf8')).toBe('external diagnostic\n');
  expect(readFileSync(join(unknown, 'not-an-ok-diagnostic.txt'), 'utf8')).toBe('do not remove');
});

test('spawn preparation lets the event loop release a contended registry without sweeping', async () => {
  const old = oldNamespace(project('inactive-before-spawn'));
  const contender = new DatabaseSync(registryPath);
  contender.exec('BEGIN IMMEDIATE');
  const release = new Promise<void>((resolve) => {
    setImmediate(() => {
      contender.close();
      resolve();
    });
  });
  const projectDir = project('spawn-attempt');
  const result = prepareSpawnProjectLogsDir(projectDir, {
    home,
    authorityRegistryPath: registryPath,
  }).then(
    (path) => ({ path }),
    (error: unknown) => ({ error }),
  );
  await release;
  expect(await result).toEqual({ path: okProjectLogsDir(projectDir, home) });
  expect(existsSync(old)).toBe(true);
});

test('namespace enumeration does not hold the ownership write transaction', () => {
  const old = oldNamespace(project('scan-outside-transaction'));
  const logRoot = dirname(old);
  const observations: boolean[] = [];
  const original = nodeFs.readdirSync;
  vi.spyOn(nodeFs, 'readdirSync').mockImplementation((...args: Parameters<typeof original>) => {
    if (args[0] === logRoot) {
      const contender = new DatabaseSync(registryPath, { timeout: 0 });
      try {
        try {
          contender.exec('BEGIN IMMEDIATE');
          observations.push(false);
        } catch {
          observations.push(true);
        }
      } finally {
        contender.close();
      }
    }
    return original(...args);
  });
  prepare();
  expect(observations).toEqual([false]);
  expect(existsSync(old)).toBe(false);
});

test.each(['contention', 'foreign-lease'])(
  'cleanup stops with one warning when ownership changes after enumeration (%s)',
  (failure) => {
    const first = oldNamespace(project('contended-first'));
    const second = oldNamespace(project('contended-second'));
    const logRoot = dirname(first);
    const original = nodeFs.readdirSync;
    let contender: DatabaseSync | undefined;
    const warn = vi.spyOn(getLogger('project-logs-retention'), 'warn');
    const authorityWarn = vi.spyOn(getLogger('server-authority'), 'warn');
    vi.spyOn(nodeFs, 'readdirSync').mockImplementation((...args: Parameters<typeof original>) => {
      if (args[0] === logRoot && !contender) {
        contender = new DatabaseSync(registryPath, { timeout: 0 });
        if (failure === 'contention') {
          contender.exec('BEGIN IMMEDIATE');
        } else {
          contender
            .prepare('INSERT INTO server_authority VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
              randomUUID(),
              randomUUID(),
              process.pid,
              'future-protocol:v2',
              root,
              JSON.stringify({ kind: 'tree', path: root, excluded: [] }),
              new Date().toISOString(),
            );
        }
      }
      return original(...args);
    });
    try {
      prepare();
      expect(warn.mock.calls.length + authorityWarn.mock.calls.length).toBe(1);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
    } finally {
      contender?.close();
    }
  },
);

test.each(['freshness', 'unknown-file'])(
  'the deletion transaction rechecks changed %s after candidate selection',
  (change) => {
    const old = oldNamespace(project('changed-after-selection'));
    const original = authority.withServerAuthorityProjectDirs;
    let calls = 0;
    vi.spyOn(authority, 'withServerAuthorityProjectDirs').mockImplementation(
      (fn, path, timeout) => {
        calls += 1;
        if (calls === 2) {
          if (change === 'freshness') {
            const now = new Date();
            utimesSync(old, now, now);
          } else {
            writeFileSync(join(old, 'unfamiliar.txt'), 'preserve this file');
            const aged = eightDaysAgo();
            utimesSync(old, aged, aged);
          }
        }
        return original(fn, path, timeout);
      },
    );
    prepare();
    expect(calls).toBe(2);
    expect(existsSync(old)).toBe(true);
    expect(readFileSync(join(old, 'server-current.jsonl'), 'utf8')).toBe('retained diagnostic\n');
    if (change === 'unknown-file')
      expect(readFileSync(join(old, 'unfamiliar.txt'), 'utf8')).toBe('preserve this file');
  },
);
