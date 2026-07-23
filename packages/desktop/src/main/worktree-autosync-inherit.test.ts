import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveRootAutoSync, seedWorktreeAutoSync } from './worktree-autosync-inherit.ts';

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

describe('resolveRootAutoSync', () => {
  test('per-machine enabled wins over the committed default', async () => {
    const root = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { enabled: true } },
    });
    await writeConfigPatch({
      cwd: root,
      scope: 'project',
      patch: { autoSync: { default: false } },
    });
    expect(resolveRootAutoSync(root)).toBe(true);
  });

  test('falls back to the committed default when per-machine is unset', async () => {
    const root = tmp();
    await writeConfigPatch({ cwd: root, scope: 'project', patch: { autoSync: { default: true } } });
    expect(resolveRootAutoSync(root)).toBe(true);
  });

  test('null when neither is answered', () => {
    expect(resolveRootAutoSync(tmp())).toBeNull();
  });
});

describe('seedWorktreeAutoSync', () => {
  test('seeds the worktree enabled + arms the one-time notice from the root setting', async () => {
    const root = tmp();
    const wt = tmp();
    await writeConfigPatch({
      cwd: root,
      scope: 'project-local',
      patch: { autoSync: { enabled: false } },
    });
    await seedWorktreeAutoSync(wt, root);
    const parsed = parseYaml(readFileSync(resolveConfigPath('project-local', wt), 'utf-8'));
    expect(parsed.autoSync.enabled).toBe(false);
    expect(parsed.autoSync.inheritedNoticePending).toBe(true);
    expect(parsed.autoSync.inheritedFrom).toBe(basename(root));
  });

  test('no-op when the root is unanswered — the worktree prompts normally', async () => {
    const root = tmp();
    const wt = tmp();
    await seedWorktreeAutoSync(wt, root);
    expect(existsSync(resolveConfigPath('project-local', wt))).toBe(false);
  });
});
