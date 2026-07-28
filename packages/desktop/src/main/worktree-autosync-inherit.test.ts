import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';
import { resolveRootAutoSyncMode, seedWorktreeAutoSync } from './worktree-autosync-inherit.ts';

// Capture the seed site's structured telemetry without touching the real pino
// destination. `getLogger` caches by subsystem, so the spy intercepts the same
// instance the module resolves at call time.
function captureSeedLogs(): {
  entries: Array<{ data: Record<string, unknown>; msg: string }>;
  restore: () => void;
} {
  const entries: Array<{ data: Record<string, unknown>; msg: string }> = [];
  const logger = getLogger('worktree-autosync');
  const record = (data: Record<string, unknown>, msg: string): void => {
    entries.push({ data, msg });
  };
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(record);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(record);
  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wt-autosync-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('resolveRootAutoSyncMode', () => {
  test('per-machine mode wins over the committed default', async () => {
    const root = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { mode: 'pull' } },
    });
    await writeConfigPatch({
      cwd: root,
      scope: 'project',
      patch: { autoSync: { default: 'full' } },
    });
    expect(resolveRootAutoSyncMode(root)).toBe('follow');
  });

  test('derives the mode from a legacy per-machine enabled boolean', async () => {
    const root = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { enabled: true } },
    });
    expect(resolveRootAutoSyncMode(root)).toBe('full');
  });

  test('falls back to a mode-valued committed default when per-machine is unset', async () => {
    const root = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project',
      patch: { autoSync: { default: 'pull' } },
    });
    expect(resolveRootAutoSyncMode(root)).toBe('follow');
  });

  test('falls back to a legacy boolean committed default', async () => {
    const root = tmp();
    await writeConfigPatch({ cwd: root, scope: 'project', patch: { autoSync: { default: true } } });
    expect(resolveRootAutoSyncMode(root)).toBe('full');
  });

  test('null when neither is answered', () => {
    expect(resolveRootAutoSyncMode(tmp())).toBeNull();
  });
});

describe('seedWorktreeAutoSync', () => {
  test('seeds the worktree mode + arms the one-time notice from the root setting', async () => {
    const root = tmp();
    const wt = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { mode: 'pull' } },
    });
    await seedWorktreeAutoSync(wt, root);
    const parsed = parseYaml(readFileSync(resolveConfigPath('project-local', wt), 'utf-8'));
    expect(parsed.autoSync.mode).toBe('follow');
    expect(parsed.autoSync.inheritedNoticePending).toBe(true);
    expect(parsed.autoSync.inheritedFrom).toBe(basename(root));
  });

  test('seeds from a committed default when per-machine is unset', async () => {
    const root = tmp();
    const wt = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project',
      patch: { autoSync: { default: 'full' } },
    });
    await seedWorktreeAutoSync(wt, root);
    const parsed = parseYaml(readFileSync(resolveConfigPath('project-local', wt), 'utf-8'));
    expect(parsed.autoSync.mode).toBe('full');
  });

  test('no-op when the root is unanswered — the worktree prompts normally', async () => {
    const root = tmp();
    const wt = tmp();
    await seedWorktreeAutoSync(wt, root);
    expect(existsSync(resolveConfigPath('project-local', wt))).toBe(false);
  });

  test('logs the inherited mode with the worktree-inherit telemetry source', async () => {
    const root = tmp();
    const wt = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { mode: 'pull' } },
    });
    const cap = captureSeedLogs();
    try {
      await seedWorktreeAutoSync(wt, root);
      const entry = cap.entries.find((e) => e.msg === 'seeded inherited autoSync mode');
      expect(entry).toBeDefined();
      expect(entry?.data).toEqual({ to: 'follow', source: 'worktree-inherit' });
    } finally {
      cap.restore();
    }
  });

  test('emits no seed telemetry when the root is unanswered', async () => {
    const root = tmp();
    const wt = tmp();
    const cap = captureSeedLogs();
    try {
      await seedWorktreeAutoSync(wt, root);
      expect(cap.entries.some((e) => e.msg === 'seeded inherited autoSync mode')).toBe(false);
    } finally {
      cap.restore();
    }
  });
});
