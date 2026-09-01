import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { handleSeedApply, handleSeedPlan } from '../../src/main/ipc/seed.ts';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ok-seed-ipc-test-'));
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function scaffoldOkDir(dir: string): void {
  mkdirSync(join(dir, OK_DIR), { recursive: true });
  writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: .\n', 'utf-8');
}

describe('handleSeedPlan', () => {
  test('returns {ok:true, plan} when a project is bound and .ok/ exists', async () => {
    scaffoldOkDir(testDir);
    const result = await handleSeedPlan({ resolveProjectRoot: () => testDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.created.length).toBeGreaterThan(0);
    }
  });

  test('returns {ok:false, no-project} when no project is bound to the window', async () => {
    const result = await handleSeedPlan({ resolveProjectRoot: () => undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('no-project');
    }
  });

  test('returns {ok:false, prerequisite-missing} when .ok/ is absent', async () => {
    const result = await handleSeedPlan({ resolveProjectRoot: () => testDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('prerequisite-missing');
      expect(result.error.message).toContain('ok init');
    }
  });

  test('surfaces internal errors as {ok:false, internal}', async () => {
    scaffoldOkDir(testDir);
    const result = await handleSeedPlan({
      resolveProjectRoot: () => testDir,
      planSeed: async () => {
        throw new Error('boom');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('internal');
      expect(result.error.message).toBe('boom');
    }
  });

  test('preview mode plans without a bound project and reports every entry as created', async () => {
    const result = await handleSeedPlan(
      { resolveProjectRoot: () => undefined },
      { packId: 'knowledge-base', preview: { skillsInstallable: true } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.skipped).toEqual([]);
    expect(result.plan.created.some((e) => e.path === 'log.md')).toBe(true);
    expect(result.plan.packSkills?.length).toBeGreaterThan(0);
    expect(result.plan.packSkills?.every((s) => s.pending)).toBe(true);
  });

  test('preview mode reports skills as not pending when no editor is selected', async () => {
    const result = await handleSeedPlan(
      { resolveProjectRoot: () => undefined },
      { packId: 'knowledge-base', preview: { skillsInstallable: false } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.packSkills?.some((s) => s.pending)).toBe(false);
  });

  test('rejects an unknown packId rather than falling back to the default pack', async () => {
    scaffoldOkDir(testDir);
    const options = { packId: 'not-a-real-pack' } as unknown as Parameters<
      typeof handleSeedPlan
    >[1];
    const result = await handleSeedPlan({ resolveProjectRoot: () => testDir }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('internal');
      expect(result.error.message).toMatch(/Unknown packId/);
    }
  });

  test('rejects an unknown packId in preview mode too', async () => {
    const options = {
      packId: 'not-a-real-pack',
      preview: { skillsInstallable: true },
    } as unknown as Parameters<typeof handleSeedPlan>[1];
    const result = await handleSeedPlan({ resolveProjectRoot: () => undefined }, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('internal');
      expect(result.error.message).toMatch(/Unknown packId/);
    }
  });

  test('preview mode scopes the plan to rootDir', async () => {
    const result = await handleSeedPlan(
      { resolveProjectRoot: () => undefined },
      { packId: 'knowledge-base', rootDir: 'brain', preview: { skillsInstallable: true } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.created.some((e) => e.path === 'brain/log.md')).toBe(true);
  });

  test('returns {ok:false, invalid-root} when rootDir resolves outside projectDir', async () => {
    scaffoldOkDir(testDir);
    const result = await handleSeedPlan(
      { resolveProjectRoot: () => testDir },
      { rootDir: '/tmp/escape' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-root');
      expect(result.error.message).toContain('relative');
    }
  });
});

describe('handleSeedApply', () => {
  test('returns {ok:true, result} on successful apply', async () => {
    scaffoldOkDir(testDir);
    const planResult = await handleSeedPlan({ resolveProjectRoot: () => testDir });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const applyResult = await handleSeedApply(
      { resolveProjectRoot: () => testDir },
      planResult.plan,
    );
    expect(applyResult.ok).toBe(true);
    if (applyResult.ok) {
      expect(applyResult.result.applied).toBeGreaterThan(0);
      expect(applyResult.result.errors).toEqual([]);
    }
    expect(existsSync(join(testDir, 'external-sources'))).toBe(true);
    expect(existsSync(join(testDir, 'research'))).toBe(true);
    expect(existsSync(join(testDir, 'articles'))).toBe(true);
    expect(existsSync(join(testDir, 'log.md'))).toBe(true);
  });

  test('returns {ok:false, no-project} when no project is bound', async () => {
    const applyResult = await handleSeedApply(
      { resolveProjectRoot: () => undefined },
      { created: [], skipped: [], warnings: [] },
    );
    expect(applyResult.ok).toBe(false);
    if (!applyResult.ok) {
      expect(applyResult.error.kind).toBe('no-project');
    }
  });

  test('surfaces internal errors', async () => {
    const applyResult = await handleSeedApply(
      {
        resolveProjectRoot: () => testDir,
        applySeed: async () => {
          throw new Error('kaboom');
        },
      },
      { created: [], skipped: [], warnings: [] },
    );
    expect(applyResult.ok).toBe(false);
    if (!applyResult.ok) {
      expect(applyResult.error.kind).toBe('internal');
      expect(applyResult.error.message).toBe('kaboom');
    }
  });
});
