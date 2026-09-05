import { describe, expect, it } from 'vitest';
import {
  type BuildArtifactCheck,
  evaluateBuild,
  formatMissingArtifacts,
  formatStaleArtifacts,
  runBuildGuard,
} from './stale-build-guard.ts';

const MAIN: BuildArtifactCheck = {
  name: 'main',
  out: '/pkg/out/main/index.js',
  srcs: ['/pkg/src/main/index.ts'],
};

const CLI: BuildArtifactCheck = {
  name: '@inkeep/open-knowledge CLI',
  out: '/pkg/../cli/dist/index.mjs',
  srcs: [],
};

describe('evaluateBuild — missing-artifact polarity', () => {
  it('reports a missing required artifact instead of silently passing', () => {
    const verdict = evaluateBuild({
      checks: [MAIN],
      exists: () => false,
      mtimeMs: () => 0,
      smokeEnabled: true,
      packagedOverride: undefined,
    });
    expect(verdict.missing).toEqual([{ name: 'main', out: '/pkg/out/main/index.js' }]);
  });

  it('reports a missing CLI build — the artifact that used to surface as a readiness timeout', () => {
    const verdict = evaluateBuild({
      checks: [MAIN, CLI],
      exists: (p) => p !== CLI.out,
      mtimeMs: () => 0,
      smokeEnabled: true,
      packagedOverride: undefined,
    });
    expect(verdict.missing).toEqual([{ name: CLI.name, out: CLI.out }]);
  });

  it('stays quiet when smoke is not enabled, so a non-smoke run still lists tests', () => {
    const verdict = evaluateBuild({
      checks: [MAIN],
      exists: () => false,
      mtimeMs: () => 0,
      smokeEnabled: false,
      packagedOverride: undefined,
    });
    expect(verdict.missing).toEqual([]);
  });

  it('stays quiet for unpackaged artifacts when a packaged app is under test', () => {
    const verdict = evaluateBuild({
      checks: [MAIN],
      exists: () => false,
      mtimeMs: () => 0,
      smokeEnabled: true,
      packagedOverride: '/Applications/OpenKnowledge.app',
    });
    expect(verdict.missing).toEqual([]);
  });
});

describe('evaluateBuild — staleness (preserved behaviour)', () => {
  it('flags a source newer than its build output', () => {
    const verdict = evaluateBuild({
      checks: [MAIN],
      exists: () => true,
      mtimeMs: (p) => (p === MAIN.out ? 100 : 200),
      smokeEnabled: true,
      packagedOverride: undefined,
    });
    expect(verdict.stale).toHaveLength(1);
    expect(verdict.stale[0]).toContain('is newer than');
  });

  it('passes a build newer than its sources', () => {
    const verdict = evaluateBuild({
      checks: [MAIN],
      exists: () => true,
      mtimeMs: (p) => (p === MAIN.out ? 300 : 200),
      smokeEnabled: true,
      packagedOverride: undefined,
    });
    expect(verdict.stale).toEqual([]);
  });
});

describe('runBuildGuard', () => {
  it('throws naming the missing artifact and the build command', () => {
    expect(() =>
      runBuildGuard({
        checks: [CLI],
        exists: () => false,
        mtimeMs: () => 0,
        smokeEnabled: true,
        packagedOverride: undefined,
      }),
    ).toThrow(/@inkeep\/open-knowledge CLI/);
  });

  it('names the CLI build command only when the CLI artifact is the missing one', () => {
    expect(formatMissingArtifacts([{ name: CLI.name, out: CLI.out }])).toContain(
      'pnpm --filter @inkeep/open-knowledge run build',
    );
    expect(formatMissingArtifacts([{ name: 'main', out: MAIN.out }])).not.toContain(
      'pnpm --filter @inkeep/open-knowledge run build',
    );
  });

  it('prefers the missing-artifact error over the staleness error', () => {
    expect(() =>
      runBuildGuard({
        checks: [MAIN, CLI],
        exists: (p) => p !== CLI.out,
        mtimeMs: (p) => (p === MAIN.out ? 100 : 200),
        smokeEnabled: true,
        packagedOverride: undefined,
      }),
    ).toThrow(/Required desktop build artifact missing/);
  });

  it('reports the staleness error when nothing is missing', () => {
    expect(() =>
      runBuildGuard({
        checks: [MAIN],
        exists: () => true,
        mtimeMs: (p) => (p === MAIN.out ? 100 : 200),
        smokeEnabled: true,
        packagedOverride: undefined,
      }),
    ).toThrow(/Stale desktop build detected/);
  });

  it('names every stale source and the rebuild command', () => {
    const message = formatStaleArtifacts([`  main: ${MAIN.srcs[0]} is newer than ${MAIN.out}`]);
    expect(message).toContain(MAIN.srcs[0] ?? '');
    expect(message).toContain('pnpm run build:desktop');
  });
});

describe('the packaged escape hatch answers both branches the same way', () => {
  it('stays quiet on a stale unpackaged out/ when a packaged app is under test', () => {
    expect(
      evaluateBuild({
        checks: [MAIN],
        exists: () => true,
        mtimeMs: (p) => (p === MAIN.out ? 100 : 200),
        smokeEnabled: true,
        packagedOverride: '/Applications/OpenKnowledge.app',
      }),
    ).toEqual({ missing: [], stale: [] });
  });

  it('an explicit undefined override means not-packaged, whatever the ambient env says', () => {
    const previous = process.env.OK_DESKTOP_PACKAGED_APP;
    process.env.OK_DESKTOP_PACKAGED_APP = '/Applications/OpenKnowledge.app';
    try {
      expect(
        evaluateBuild({
          checks: [MAIN],
          exists: () => false,
          mtimeMs: () => 0,
          smokeEnabled: true,
          packagedOverride: undefined,
        }).missing,
      ).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.OK_DESKTOP_PACKAGED_APP;
      else process.env.OK_DESKTOP_PACKAGED_APP = previous;
    }
  });
});

describe('the real CHECKS list, not an injected one', () => {
  it('names the module entry the unpackaged utility process actually loads', () => {
    const verdict = evaluateBuild({
      exists: () => false,
      mtimeMs: () => 0,
      smokeEnabled: true,
      packagedOverride: undefined,
    });
    const cli = verdict.missing.find((m) => m.name.includes('CLI'));
    expect(cli?.out).toMatch(/cli[/\\]dist[/\\]index\.mjs$/);
    expect(verdict.missing.map((m) => m.name)).toEqual([
      'main',
      'preload',
      'renderer',
      'utility server entry',
      '@inkeep/open-knowledge CLI',
    ]);
  });
});
