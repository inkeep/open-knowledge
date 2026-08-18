import { describe, expect, test } from 'vitest';
import { createRealOpenDeps, type OpenDeps, runOpen } from './open.ts';

function makeDeps(overrides: Partial<OpenDeps> = {}): {
  deps: OpenDeps;
  opened: string[];
  logs: string[];
  errors: string[];
} {
  const opened: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: OpenDeps = {
    detectBundlePath: () => null,
    resolveBaseUrl: () => null,
    // Default: nothing is a folder on disk, so tests opt into folder routing via
    // an explicit override, `--folder`, or a trailing slash.
    classifyName: () => 'doc',
    openTarget: async (t) => {
      opened.push(t);
      return { ok: true };
    },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    ...overrides,
  };
  return { deps, opened, logs, errors };
}

describe('runOpen', () => {
  test('doc with a desktop bundle → openknowledge:// deep link, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen('bim-brain/log', { project: '/abs/proj' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fabs%2Fproj&doc=bim-brain%2Flog']);
  });

  test('doc, no bundle but UI running → browser route, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
    });
    const code = await runOpen('specs/foo/SPEC', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/specs/foo/SPEC']);
  });

  test('launcher failure returns exit 1 without printing a success message', async () => {
    const { deps, logs, errors } = makeDeps({
      detectBundlePath: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
      openTarget: async () => ({ ok: false, reason: 'not-installed' }),
    });

    const code = await runOpen('specs/foo/SPEC', { project: '/p' }, deps);

    expect(code).toBe(1);
    expect(logs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Could not open http://localhost:5173/#/specs/foo/SPEC');
    expect(errors[0]).toContain('is not installed or cannot be executed');
  });

  test('doc, neither desktop nor UI → error, exit 1, nothing opened', async () => {
    const { deps, opened, errors } = makeDeps();
    const code = await runOpen('foo', { project: '/p' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('folder with a desktop bundle → folder= deep link, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen('specs/foo/', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fp&folder=specs%2Ffoo']);
  });

  test('folder, no bundle but UI running → browser folder route, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
    });
    const code = await runOpen('specs/foo/', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/specs/foo/']);
  });

  test('auto-detects a folder from disk (no trailing slash needed)', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
      classifyName: () => 'folder',
    });
    const code = await runOpen('specs/foo', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fp&folder=specs%2Ffoo']);
  });

  test('trailing slash infers folder intent even when disk classify says doc', async () => {
    const { deps, opened } = makeDeps({
      resolveBaseUrl: () => 'http://localhost:5173',
      classifyName: () => 'doc',
    });
    const code = await runOpen('specs/foo/', {}, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/specs/foo/']);
  });

  test('skill with a desktop bundle → rides doc=__skill__/<scope>/<name> deep link', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen('trip-log', { skill: true, project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual([
      'openknowledge://open?project=%2Fp&doc=__skill__%2Fproject%2Ftrip-log',
    ]);
  });

  test('skill --scope global, no bundle but UI running → browser skill route', async () => {
    const { deps, opened } = makeDeps({ resolveBaseUrl: () => 'http://localhost:5173' });
    const code = await runOpen('trip-log', { skill: true, scope: 'global', project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/__skill__/global/trip-log']);
  });

  test('skill with an invalid --scope → error, exit 1', async () => {
    const { deps, errors } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen('trip-log', { skill: true, scope: 'nonsense', project: '/p' }, deps);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test('skill, neither desktop nor UI → error, exit 1, nothing opened', async () => {
    const { deps, opened, errors } = makeDeps();
    const code = await runOpen('trip-log', { skill: true, project: '/p' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('skill name with a traversal/unsafe segment → error before any open', async () => {
    // The unsafe-name guard runs before the skill branch, so a malicious skill
    // name can't slip into the synthetic `__skill__/<scope>/<name>` target.
    const { deps, opened, errors } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    for (const bad of ['../../etc', '/abs', 'a\\b']) {
      const code = await runOpen(bad, { skill: true, project: '/p' }, deps);
      expect(code).toBe(1);
    }
    expect(opened).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test('folder with no UI running → error, exit 1', async () => {
    const { deps, errors } = makeDeps({ resolveBaseUrl: () => null });
    const code = await runOpen('specs/foo/', { project: '/p' }, deps);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test('empty target (bare slash) → error, exit 1', async () => {
    const { deps, errors } = makeDeps();
    const code = await runOpen('/', {}, deps);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test.each([
    ['..', '../sibling'],
    ['nested ..', 'a/../b'],
    ['leading slash', '/abs/doc'],
    ['backslash', 'a\\b'],
  ])('rejects names the desktop parser would drop (%s) instead of false success', async (_label, name) => {
    const { deps, opened, errors } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen(name, { project: '/p' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('rejects unsafe folder names too', async () => {
    const { deps, opened, errors } = makeDeps({ resolveBaseUrl: () => 'http://localhost:5173' });
    const code = await runOpen('specs/..', { project: '/p' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  // The deep-link path (encodeURIComponent) and the browser-route path
  // (encodeDocName, per-segment) intentionally diverge on `/`: the deep link
  // encodes it to %2F, the browser route preserves it as a path separator.
  test('doc deep link encodes the whole name including the slash (%2F)', async () => {
    const { deps, opened } = makeDeps({
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runOpen('notes/My Doc#1', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fp&doc=notes%2FMy%20Doc%231']);
  });

  test('browser route encodes per-segment, preserving the slash', async () => {
    const { deps, opened } = makeDeps({ resolveBaseUrl: () => 'http://localhost:5173' });
    const code = await runOpen('notes/My Doc#1', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/notes/My%20Doc%231']);
  });
});

describe('createRealOpenDeps wiring', () => {
  test('detectBundlePath collapses a bundlePath-absent DetectResult to null (the force-browser/no-bundle contract)', () => {
    const deps = createRealOpenDeps(() => ({ available: false, reason: 'force-browser' }));
    expect(deps.detectBundlePath()).toBeNull();
  });

  test('detectBundlePath returns the bundle path when detect reports one', () => {
    const deps = createRealOpenDeps(() => ({
      available: true,
      reason: 'available',
      bundlePath: '/Applications/OpenKnowledge.app',
    }));
    expect(deps.detectBundlePath()).toBe('/Applications/OpenKnowledge.app');
  });

  // The headless-agent contract: a bundle is present but `available` is false
  // (non-TTY) — the collapse keys on bundlePath, so desktop routing still fires.
  // Pins against a regression that re-gates on `available`.
  test('detectBundlePath returns the bundle path when available:false but bundlePath is set', () => {
    const deps = createRealOpenDeps(() => ({
      available: false,
      reason: 'headless',
      bundlePath: '/Applications/OpenKnowledge.app',
    }));
    expect(deps.detectBundlePath()).toBe('/Applications/OpenKnowledge.app');
  });
});
