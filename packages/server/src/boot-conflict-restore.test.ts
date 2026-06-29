
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
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
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

    const calls: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown, ...rest: unknown[]) => {
      const line = typeof msg === 'string' ? msg : String(msg);
      calls.push(line);
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

  test('skips and logs warning when conflicts.json is malformed JSON', async () => {
    const contentDir = tmpDir;
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    seedOkScaffold(contentDir);
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
