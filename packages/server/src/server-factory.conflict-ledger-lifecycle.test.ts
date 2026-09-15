import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';

const execFileAsync = promisify(execFile);
const TEST_CONFIG = ConfigSchema.parse({});

const DOC_NAME = 'notes/topic';
const DOC_FILE = 'notes/topic.md';

const MARKERED_BODY = [
  '# Topic',
  '',
  '<<<<<<< ours',
  'ours side',
  '=======',
  'theirs side',
  '>>>>>>> theirs',
  '',
].join('\n');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-conflict-ledger-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), 'local/\n', 'utf-8');
}

function seedMergeNativeConflictsJson(projectDir: string, file: string): void {
  const localDir = resolve(projectDir, OK_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    resolve(localDir, 'conflicts.json'),
    JSON.stringify({
      version: 1,
      branch: 'main',
      conflicts: [{ kind: 'merge-native', file, detectedAt: '2026-05-19T00:00:00.000Z' }],
    }),
    'utf-8',
  );
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

async function writeProbe(
  port: number,
  markdown: string,
  docName: string = DOC_NAME,
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace', agentId: 'probe' }),
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

function seedReconcileConflictsJson(projectDir: string, file: string): void {
  const localDir = resolve(projectDir, OK_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    resolve(localDir, 'conflicts.json'),
    JSON.stringify({
      version: 1,
      branch: 'main',
      conflicts: [
        {
          kind: 'reconcile',
          file,
          detectedAt: '2026-05-19T00:00:00.000Z',
          reason: 'disk-markers',
          stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
        },
      ],
    }),
    'utf-8',
  );
}

async function bootPlainProject(seed: (contentDir: string) => void): Promise<{
  port: number;
  destroy: () => Promise<void>;
}> {
  const contentDir = tmpDir;
  await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
  seedOkScaffold(contentDir);
  seed(contentDir);
  const booted = await bootServer({
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
  });
  return {
    port: booted.port,
    destroy: async () => {
      await booted.destroy();
    },
  };
}

describe('conflict ledger boot prune runs independently of the sync engine', () => {
  test('a stale merge-native entry is gone at boot with sync off and no MERGE_HEAD', async () => {
    const booted = await bootPlainProject((contentDir) => {
      mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
      writeFileSync(resolve(contentDir, DOC_FILE), 'line1\n', 'utf-8');
      seedMergeNativeConflictsJson(contentDir, DOC_FILE);
    });
    try {
      await pollUntil(
        () => isIndexed(booted.port, DOC_NAME),
        30_000,
        'the initial file-watcher scan to index the doc',
      );
      expect(existsSync(resolve(tmpDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(await listConflictFiles(booted.port)).toEqual([]);
      expect(await writeProbe(booted.port, '# probe\n')).toBe(200);
    } finally {
      await booted.destroy();
    }
  }, 120_000);

  test('a mixed ledger keeps the working-tree and reconcile entries and drops only merge-native', async () => {
    const trackedFile = 'notes/tracked.md';
    const trackedDoc = 'notes/tracked';
    const reconcileFile = 'notes/local.md';

    await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
    seedOkScaffold(tmpDir);
    mkdirSync(resolve(tmpDir, 'notes'), { recursive: true });
    writeFileSync(resolve(tmpDir, DOC_FILE), 'line1\n', 'utf-8');
    writeFileSync(resolve(tmpDir, trackedFile), 'tracked local\n', 'utf-8');
    writeFileSync(resolve(tmpDir, reconcileFile), MARKERED_BODY, 'utf-8');

    const theirsSha = (
      await execFileAsync('git', ['hash-object', '-w', trackedFile], { cwd: tmpDir })
    ).stdout.trim();
    expect(theirsSha).toMatch(/^[0-9a-f]{40}$/);

    const localDir = resolve(tmpDir, OK_DIR, 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      resolve(localDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: [
          { kind: 'merge-native', file: DOC_FILE, detectedAt: '2026-05-19T00:00:00.000Z' },
          {
            kind: 'working-tree',
            file: trackedFile,
            detectedAt: '2026-05-19T00:00:00.000Z',
            theirsSha,
          },
          {
            kind: 'reconcile',
            file: reconcileFile,
            detectedAt: '2026-05-19T00:00:00.000Z',
            reason: 'disk-markers',
            stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
          },
        ],
      }),
      'utf-8',
    );

    const booted = await bootServer({
      config: TEST_CONFIG,
      contentDir: tmpDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
    });
    try {
      await pollUntil(
        () => isIndexed(booted.port, trackedDoc),
        30_000,
        'the initial file-watcher scan to index the tracked doc',
      );
      expect(existsSync(resolve(tmpDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect((await listConflictFiles(booted.port)).sort()).toEqual(
        [trackedFile, reconcileFile].sort(),
      );
      expect(await writeProbe(booted.port, '# blocked\n', trackedDoc)).toBe(409);
      expect(await writeProbe(booted.port, '# probe\n')).toBe(200);
    } finally {
      await booted.destroy();
    }
  }, 120_000);
});

describe('a reconcile entry scoped to another branch does not survive a boot here', () => {
  test('the entry is gone at boot and the doc is writable again', async () => {
    const booted = await bootPlainProject((contentDir) => {
      mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
      writeFileSync(resolve(contentDir, DOC_FILE), MARKERED_BODY, 'utf-8');
      const localDir = resolve(contentDir, OK_DIR, 'local');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        resolve(localDir, 'conflicts.json'),
        JSON.stringify({
          version: 2,
          branch: 'feature/elsewhere',
          conflicts: [
            {
              kind: 'reconcile',
              file: DOC_FILE,
              detectedAt: '2026-05-19T00:00:00.000Z',
              branch: 'feature/elsewhere',
              reason: 'disk-markers',
              stages: { base: 'BASE\n', ours: 'OURS\n', theirs: MARKERED_BODY },
            },
          ],
        }),
        'utf-8',
      );
    });
    try {
      await pollUntil(
        () => isIndexed(booted.port, DOC_NAME),
        30_000,
        'the initial file-watcher scan to index the doc',
      );
      expect(await listConflictFiles(booted.port)).toEqual([]);
      expect(await writeProbe(booted.port, '# probe\n')).toBe(200);
    } finally {
      await booted.destroy();
    }
  }, 120_000);
});

describe('a disk delete or rename of a conflicted doc clears its ledger entry', () => {
  test('deleting the file on disk dissolves the reconcile entry', async () => {
    const booted = await bootPlainProject((contentDir) => {
      mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
      writeFileSync(resolve(contentDir, DOC_FILE), MARKERED_BODY, 'utf-8');
      seedReconcileConflictsJson(contentDir, DOC_FILE);
    });
    try {
      await pollUntil(
        () => isIndexed(booted.port, DOC_NAME),
        30_000,
        'the initial file-watcher scan to index the conflicted doc',
      );
      expect(await listConflictFiles(booted.port)).toEqual([DOC_FILE]);

      rmSync(resolve(tmpDir, DOC_FILE), { force: true });

      await pollUntil(
        async () => (await listConflictFiles(booted.port)).length === 0,
        60_000,
        'the reconcile entry to dissolve after the disk delete',
      );
    } finally {
      await booted.destroy();
    }
  }, 120_000);

  test('renaming the file on disk dissolves the reconcile entry for the old path', async () => {
    const booted = await bootPlainProject((contentDir) => {
      mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
      writeFileSync(resolve(contentDir, DOC_FILE), MARKERED_BODY, 'utf-8');
      seedReconcileConflictsJson(contentDir, DOC_FILE);
    });
    try {
      await pollUntil(
        () => isIndexed(booted.port, DOC_NAME),
        30_000,
        'the initial file-watcher scan to index the conflicted doc',
      );
      expect(await listConflictFiles(booted.port)).toEqual([DOC_FILE]);

      renameSync(resolve(tmpDir, DOC_FILE), resolve(tmpDir, 'notes', 'moved.md'));

      await pollUntil(
        async () => (await listConflictFiles(booted.port)).length === 0,
        60_000,
        'the reconcile entry to dissolve after the disk rename',
      );
    } finally {
      await booted.destroy();
    }
  }, 120_000);
});
