import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
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
    // testDir exists, but no `.ok/` inside — triggers prerequisite error
    const result = await handleSeedPlan({ resolveProjectRoot: () => testDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('prerequisite-missing');
      expect(result.error.message).toContain('ok init');
    }
  });

  test('surfaces internal errors as {ok:false, internal}', async () => {
    scaffoldOkDir(testDir);
    // Inject a planSeed that throws a non-prerequisite error.
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

  test('returns {ok:false, invalid-root} when rootDir resolves outside projectDir', async () => {
    scaffoldOkDir(testDir);
    // Real planSeed (no inject) — exercises the typed-error path end-to-end.
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
