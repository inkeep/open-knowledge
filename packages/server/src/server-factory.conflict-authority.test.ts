import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import type { ServerInstance } from './server-factory.ts';

const execFileAsync = promisify(execFile);
const TEST_CONFIG = ConfigSchema.parse({});

const DOC_NAME = 'notes/topic';
const DOC_FILE = 'notes/topic.md';
const SCRATCH_DOC = 'notes/scratch';
const SCRATCH_FILE = 'notes/scratch.md';
const COLLISION_FILE = 'notes/pull-collision.md';
const CONTROL_MARKER = 'stored while the batch was down';
const DEFERRED_MARKER = 'drained by the resolve';

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), 'local/\n', 'utf-8');
}

function seedConflictsJson(projectDir: string, file: string): void {
  const localDir = resolve(projectDir, OK_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    resolve(localDir, 'conflicts.json'),
    JSON.stringify(
      {
        version: 1,
        branch: 'main',
        conflicts: [{ kind: 'merge-native', file, detectedAt: '2026-05-19T00:00:00.000Z' }],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function seedRealMergeConflict(projectDir: string, filePath: string): Promise<void> {
  const opts = { cwd: projectDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
  mkdirSync(resolve(projectDir, 'notes'), { recursive: true });
  writeFileSync(resolve(projectDir, filePath), 'line1\nline2\nline3\n', 'utf-8');
  await execFileAsync('git', ['add', '-A'], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  writeFileSync(resolve(projectDir, filePath), 'line1\nUPSTREAM\nline3\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
  await execFileAsync('git', ['checkout', 'main'], opts);
  writeFileSync(resolve(projectDir, filePath), 'line1\nLOCAL\nline3\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'ours'], opts);
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});
  if (!existsSync(resolve(projectDir, '.git', 'MERGE_HEAD'))) {
    throw new Error('seedRealMergeConflict: no MERGE_HEAD — the merge did not conflict');
  }
}

async function isIndexed(port: number, docName: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/api/documents`).catch(() => null);
  if (!res?.ok) return false;
  const data = (await res.json()) as { documents?: Array<{ docName: string }> };
  return data.documents?.some((d) => d.docName === docName) ?? false;
}

async function listConflictFiles(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/conflicts`).catch(() => null);
  if (!res?.ok) return [];
  const data = (await res.json()) as { conflicts?: Array<{ file: string }> };
  return (data.conflicts ?? []).map((c) => c.file);
}

async function writeDocProbe(port: number, docName: string, markdown: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace', agentId: 'probe' }),
  });
  return res.status;
}

async function writeProbe(port: number, markdown: string): Promise<number> {
  return writeDocProbe(port, DOC_NAME, markdown);
}

async function resolveConflictOverHttp(
  port: number,
  file: string,
  strategy: string,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, strategy }),
  });
  return res.status;
}

async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await wait(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-conflict-authority-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function bootWithHeldConflictedDoc(options?: {
  extraFiles?: Record<string, string>;
  load?: boolean;
}): Promise<{
  port: number;
  serverInstance: ServerInstance;
  destroy: () => Promise<void>;
  release: () => Promise<void>;
  readSource: () => string;
}> {
  const contentDir = tmpDir;
  await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
  seedOkScaffold(contentDir);
  for (const [file, body] of Object.entries(options?.extraFiles ?? {})) {
    const abs = resolve(contentDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }
  await seedRealMergeConflict(contentDir, DOC_FILE);
  seedConflictsJson(contentDir, DOC_FILE);

  const booted = await bootServer({
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
  });

  const dc =
    options?.load === false
      ? null
      : await booted.serverInstance.hocuspocus.openDirectConnection(DOC_NAME);
  await pollUntil(
    () => isIndexed(booted.port, DOC_NAME),
    30_000,
    'the initial file-watcher scan to index the conflicted doc',
  );
  return {
    port: booted.port,
    serverInstance: booted.serverInstance,
    destroy: async () => {
      await booted.destroy();
    },
    release: async () => {
      await dc?.disconnect();
    },
    readSource: () => dc?.document?.getText('source').toString() ?? '',
  };
}

describe('PRD-8318: a merge-native conflict resolved with raw git unfreezes the loaded doc', () => {
  test('ordering A — the disk event drains before HEAD moves, and the write is admitted', async () => {
    const held = await bootWithHeldConflictedDoc();
    try {
      await pollUntil(
        async () => (await listConflictFiles(held.port)).includes(DOC_FILE),
        20_000,
        'the seeded merge-native entry to be listed',
      );
      expect(await writeProbe(held.port, '# blocked\n')).toBe(409);

      const opts = { cwd: tmpDir };
      await execFileAsync('git', ['checkout', '--ours', '--', DOC_FILE], opts);
      await execFileAsync('git', ['add', '--', DOC_FILE], opts);

      await pollUntil(
        () => held.readSource().includes('LOCAL') && !held.readSource().includes('<<<<<<<'),
        30_000,
        'the server to process the disk update for the resolved file',
      );

      await execFileAsync('git', ['commit', '--no-edit'], opts);

      await pollUntil(
        async () => (await listConflictFiles(held.port)).length === 0,
        60_000,
        'the conflict ledger to empty after the external resolve',
      );

      expect(await writeProbe(held.port, '# probe\n')).toBe(200);
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);

  test('ordering B — resolved bytes on disk alone do not prune; completing the merge does', async () => {
    const held = await bootWithHeldConflictedDoc();
    try {
      await pollUntil(
        async () => (await listConflictFiles(held.port)).includes(DOC_FILE),
        20_000,
        'the seeded merge-native entry to be listed',
      );
      expect(await writeProbe(held.port, '# blocked\n')).toBe(409);

      writeFileSync(resolve(tmpDir, DOC_FILE), 'line1\nLOCAL\nline3\n', 'utf-8');

      await pollUntil(
        () => held.readSource().includes('LOCAL') && !held.readSource().includes('<<<<<<<'),
        30_000,
        'the server to process the disk update for the hand-resolved file',
      );

      const opts = { cwd: tmpDir };
      const stillUnmerged = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        opts,
      );
      expect(stillUnmerged.stdout).toContain(DOC_FILE);
      expect(await listConflictFiles(held.port)).toContain(DOC_FILE);
      expect(await writeProbe(held.port, '# still blocked\n')).toBe(409);

      await execFileAsync('git', ['add', '--', DOC_FILE], opts);
      await execFileAsync('git', ['commit', '--no-edit'], opts);

      await pollUntil(
        async () => (await listConflictFiles(held.port)).length === 0,
        60_000,
        'the conflict ledger to empty once the merge was completed',
      );

      expect(existsSync(resolve(tmpDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(await writeProbe(held.port, '# probe\n')).toBe(200);
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);

  test('a mid-merge `git add` with no commit heals through the disk-update path', async () => {
    const held = await bootWithHeldConflictedDoc();
    try {
      await pollUntil(
        async () => (await listConflictFiles(held.port)).includes(DOC_FILE),
        20_000,
        'the seeded merge-native entry to be listed',
      );

      const opts = { cwd: tmpDir };
      await execFileAsync('git', ['checkout', '--ours', '--', DOC_FILE], opts);
      await execFileAsync('git', ['add', '--', DOC_FILE], opts);

      await pollUntil(
        () => held.readSource().includes('LOCAL') && !held.readSource().includes('<<<<<<<'),
        30_000,
        'the server to process the disk update for the staged file',
      );

      await pollUntil(
        async () => (await listConflictFiles(held.port)).length === 0,
        60_000,
        'the conflict ledger to empty from the disk-update prune',
      );

      expect(existsSync(resolve(tmpDir, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(await writeProbe(held.port, '# probe\n')).toBe(200);
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);

  test('a staged merge-native entry prunes for a document that was never loaded', async () => {
    const held = await bootWithHeldConflictedDoc({ load: false });
    try {
      await pollUntil(
        async () => (await listConflictFiles(held.port)).includes(DOC_FILE),
        20_000,
        'the seeded merge-native entry to be listed',
      );
      expect(held.serverInstance.hocuspocus.documents.has(DOC_NAME)).toBe(false);

      const opts = { cwd: tmpDir };
      await execFileAsync('git', ['checkout', '--ours', '--', DOC_FILE], opts);
      await execFileAsync('git', ['add', '--', DOC_FILE], opts);

      await pollUntil(
        async () => (await listConflictFiles(held.port)).length === 0,
        60_000,
        'the disk-update prune to drop the entry for the unloaded doc',
      );

      expect(held.serverInstance.hocuspocus.documents.has(DOC_NAME)).toBe(false);
      expect(existsSync(resolve(tmpDir, '.git', 'MERGE_HEAD'))).toBe(true);
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);

  test('a resolve over HTTP drains the stores the batch deferred, with no manual flush', async () => {
    const held = await bootWithHeldConflictedDoc({
      extraFiles: { [SCRATCH_FILE]: 'scratch base\n', [COLLISION_FILE]: 'overlay\n' },
    });
    const readScratch = () => readFileSync(resolve(tmpDir, SCRATCH_FILE), 'utf-8');
    try {
      await pollUntil(
        () => isIndexed(held.port, SCRATCH_DOC),
        30_000,
        'the initial file-watcher scan to index the scratch doc',
      );

      expect(await writeDocProbe(held.port, SCRATCH_DOC, `# ${CONTROL_MARKER}\n`)).toBe(200);
      await pollUntil(
        () => readScratch().includes(CONTROL_MARKER),
        30_000,
        'an undeferred store to reach disk',
      );

      held.serverInstance.conflicts.raise({
        kind: 'working-tree',
        file: COLLISION_FILE,
        theirsSha: '0'.repeat(40),
      });

      held.serverInstance.durabilityState.setBatchInProgress(true);
      expect(await writeDocProbe(held.port, SCRATCH_DOC, `# ${DEFERRED_MARKER}\n`)).toBe(200);
      expect(readScratch()).toContain(CONTROL_MARKER);
      expect(readScratch()).not.toContain(DEFERRED_MARKER);

      expect(await listConflictFiles(held.port)).toContain(COLLISION_FILE);
      expect(await resolveConflictOverHttp(held.port, COLLISION_FILE, 'mine')).toBe(200);

      await pollUntil(
        () => readScratch().includes(DEFERRED_MARKER),
        30_000,
        'the resolve route to drain the deferred store to disk',
      );
    } finally {
      await held.release();
      await held.destroy();
    }
  }, 180_000);
});
