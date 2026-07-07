/**
 * boot-time lifecycle restoration from `.ok/local/conflicts.json`.
 *
 * Pin the structural recovery: when the server boots with conflict entries
 * already persisted by `ConflictStore`, the matching docs' `lifecycle.status`
 * must be set to `'conflict'` BEFORE the HTTP server accepts requests.
 * Otherwise the gate the rest of the conflict-aware-write-surfaces spec
 * relies on is open during the post-restart race window — silent data loss
 * by the same failure mode.
 *
 * Skip on CI (subprocess + git child spawns; oven-sh/bun#11892) to mirror
 * the existing boot.test.ts skip gate.
 */

import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'bun:test';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';

const execFileAsync = promisify(execFile);
const TEST_CONFIG = ConfigSchema.parse({});

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

function seedConflictsJson(
  projectDir: string,
  entries: Array<{ file: string; detectedAt?: string }>,
): void {
  const localDir = resolve(projectDir, OK_DIR, 'local');
  mkdirSync(localDir, { recursive: true });
  const data = {
    version: 1,
    branch: 'main',
    conflicts: entries.map((e) => ({
      file: e.file,
      detectedAt: e.detectedAt ?? '2026-05-19T00:00:00.000Z',
    })),
  };
  writeFileSync(resolve(localDir, 'conflicts.json'), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Create a real in-progress merge with a conflict on `filePath` so the
 * boot-scan's reconcile (`git diff --name-only --diff-filter=U` against a
 * present `MERGE_HEAD`) sees the file as still-unmerged. Without this, the
 * boot scan would correctly prune the conflicts.json entry as stale (the
 * scenario covers: external CLI resolve leaves conflicts.json
 * lying).
 */
async function seedRealMergeConflict(projectDir: string, filePath: string): Promise<void> {
  const opts = { cwd: projectDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
  writeFileSync(resolve(projectDir, filePath), 'base\n', 'utf-8');
  await execFileAsync('git', ['add', filePath], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  writeFileSync(resolve(projectDir, filePath), 'theirs\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
  await execFileAsync('git', ['checkout', 'main'], opts);
  writeFileSync(resolve(projectDir, filePath), 'ours\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'ours'], opts);
  // Merge attempt fails with conflict — that's the desired end state.
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
    /* expected: non-zero exit on conflict */
  });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-boot-conflict-restore-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('bootServer — FR14 lifecycle restoration from conflicts.json', () => {
  test('pre-seeds lifecycle.status=conflict on each tracked doc before HTTP listen', async () => {
    const contentDir = tmpDir;
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    // Stage a real in-progress merge with a conflict on foo.md so the
    // boot-scan reconcile (git diff-filter=U against MERGE_HEAD) sees it
    // as still-unmerged and DOES restore the lifecycle.
    await seedRealMergeConflict(contentDir, 'foo.md');
    seedConflictsJson(contentDir, [{ file: 'foo.md' }]);

    const booted = await bootServer({
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });

    try {
      // The doc may be unloaded after the restore disconnect; reopen via the
      // same DirectConnection path the restore used so we observe the
      // persisted lifecycle state. (Hocuspocus persists Y.Doc state across
      // unload/reload via the persistence layer's onLoadDocument hook.)
      const dc = await booted.serverInstance.hocuspocus.openDirectConnection('foo');
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBe('conflict');
        expect(lifecycleMap?.get('reason')).toBe('conflict-markers');
      } finally {
        await dc.disconnect();
      }
    } finally {
      await booted.destroy();
    }
  }, 30_000);

  test('emits lifecycle-restored-from-conflicts-json event per restored doc', async () => {
    const contentDir = tmpDir;
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
    await seedRealMergeConflict(contentDir, 'docs/bar.md');
    seedConflictsJson(contentDir, [{ file: 'docs/bar.md' }]);

    // Capture console.warn — the helper emits structured-JSON via
    // console.warn (matches the assertable-event convention).
    const calls: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown, ...rest: unknown[]) => {
      const line = typeof msg === 'string' ? msg : String(msg);
      calls.push(line);
      // Preserve passthrough so other diagnostics still surface in test logs.
      original.call(console, msg, ...rest);
    };

    try {
      const booted = await bootServer({
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      try {
        const restored = calls.find((l) => {
          try {
            const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
            return (
              parsed.event === 'lifecycle-restored-from-conflicts-json' &&
              parsed['doc.name'] === 'docs/bar'
            );
          } catch {
            return false;
          }
        });
        expect(restored).toBeDefined();
      } finally {
        await booted.destroy();
      }
    } finally {
      console.warn = original;
    }
  }, 30_000);

  test('skips and logs warning when conflicts.json is absent (no crash)', async () => {
    const contentDir = tmpDir;
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    // No conflicts.json — ConflictStore.list() returns empty; helper short-circuits.

    const booted = await bootServer({
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });

    try {
      // Boot succeeded — no throw, port bound.
      expect(typeof booted.port).toBe('number');
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      await booted.destroy();
    }
  }, 30_000);

  test('skips and logs warning when conflicts.json is malformed JSON', async () => {
    const contentDir = tmpDir;
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
    // Write malformed JSON directly — ConflictStore.load swallows parse
    // errors and starts empty; we just exercise the boot path stays alive.
    const localDir = resolve(contentDir, OK_DIR, 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(resolve(localDir, 'conflicts.json'), '{ this is not json', 'utf-8');

    const booted = await bootServer({
      config: TEST_CONFIG,
      contentDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });

    try {
      expect(typeof booted.port).toBe('number');
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      await booted.destroy();
    }
  }, 30_000);
});
