
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeShadowHealthCheck, type ShadowHealthFacts } from './shadow-health.ts';

let tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeProjectWithShadow(): { cwd: string; shadowDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-health-sh-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const shadowDir = join(cwd, '.git', 'ok');
  mkdirSync(shadowDir, { recursive: true });
  return { cwd, shadowDir };
}

const HEALTHY: ShadowHealthFacts = {
  looseObjects: 40,
  packfiles: 2,
  wipWidth: 3,
  deadChains: 0,
  gcLogLatch: false,
  lastPackedAtMs: Date.now() - 60_000,
  lastConsolidationAtMs: Date.now() - 120_000,
};

function check(facts: ShadowHealthFacts, shadowDir: string) {
  return makeShadowHealthCheck({
    resolveDir: () => shadowDir,
    readFacts: async () => facts,
  });
}

describe('shadow-health check', () => {
  test('warns when .git/ is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-health-nogit-'));
    tmpDirs.push(cwd);
    const result = await makeShadowHealthCheck().run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('no .git/');
  });

  test('warns when the shadow dir is not yet initialized', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-health-noshadow-'));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const def = makeShadowHealthCheck({ resolveDir: () => join(cwd, '.git', 'ok-missing') });
    const result = await def.run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('not yet initialized');
  });

  test('flags the incident-shaped repo as degraded with actionable detail', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const facts: ShadowHealthFacts = {
      looseObjects: 10_092,
      packfiles: 0,
      wipWidth: 57,
      deadChains: 41,
      gcLogLatch: true,
      lastPackedAtMs: null,
      lastConsolidationAtMs: null,
    };
    const result = await check(facts, shadowDir).run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('gc.log latch');
    expect(result.summary).toContain('10092 loose');
    expect(result.summary).toContain('57 WIP refs');
    expect(result.summary).toContain('41 dead chains');
    expect(result.detail).toContain('last packed: never');
    expect(result.remediation).toBeDefined();
  });

  test('stays quiet (pass) on a healthy repo', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check(HEALTHY, shadowDir).run({ cwd });
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('40 loose');
    expect(result.summary).toContain('2 packs');
  });

  test('a gc.log latch alone trips the warn', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, gcLogLatch: true }, shadowDir).run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('gc.log latch');
  });

  test('a wide journal alone trips the warn', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, wipWidth: 40 }, shadowDir).run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('40 WIP refs');
  });

  test('unfolded dead chains trip the warn even when width is fine', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, deadChains: 12 }, shadowDir).run({ cwd });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('12 dead chains');
  });

  test('dead-chain warn boundary: 5 stays quiet, 6 warns (strict >)', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const atThreshold = await check({ ...HEALTHY, deadChains: 5 }, shadowDir).run({ cwd });
    expect(atThreshold.status).toBe('pass');
    const over = await check({ ...HEALTHY, deadChains: 6 }, shadowDir).run({ cwd });
    expect(over.status).toBe('warn');
    expect(over.summary).toContain('6 dead chains');
  });

  test('heavy live load (wide journal, zero dead chains) does not warn on dead chains', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, wipWidth: 50, deadChains: 0 }, shadowDir).run({ cwd });
    expect(result.status).toBe('warn'); // width still flags read latency
    expect(result.summary).toContain('50 WIP refs');
    expect(result.summary).not.toContain('dead chains');
  });

  test('a never-packed repo (0 packfiles, loose over gc.auto) trips the warn', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, packfiles: 0, looseObjects: 800 }, shadowDir).run({
      cwd,
    });
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('never packed');
  });

  test('does not leak KB-owner-facing consolidation/maintenance marketing copy', async () => {
    const { cwd, shadowDir } = makeProjectWithShadow();
    const result = await check({ ...HEALTHY, wipWidth: 40 }, shadowDir).run({ cwd });
    expect(result.summary.toLowerCase()).not.toContain('save version');
  });
});
