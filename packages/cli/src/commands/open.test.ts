import { describe, expect, test } from 'vitest';
import type { OpenTargetOptions } from '../utils/open-target.ts';
import {
  type DesktopAppTarget,
  type DetectDeps,
  type DetectResult,
  detectDesktop,
} from './desktop-dispatch.ts';
import { createRealOpenDeps, type OpenDeps, runOpen } from './open.ts';

const STABLE_APP: DesktopAppTarget = {
  bundlePath: '/Applications/OpenKnowledge.app',
  protocolScheme: 'openknowledge',
};

const BETA_APP: DesktopAppTarget = {
  bundlePath: '/Applications/OpenKnowledge Beta.app',
  protocolScheme: 'openknowledge-beta',
};

function makeDeps(overrides: Partial<OpenDeps> = {}): {
  deps: OpenDeps;
  opened: string[];
  openedOptions: Array<Pick<OpenTargetOptions, 'desktopBundlePath'> | undefined>;
  logs: string[];
  errors: string[];
} {
  const opened: string[] = [];
  const openedOptions: Array<Pick<OpenTargetOptions, 'desktopBundlePath'> | undefined> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: OpenDeps = {
    detectDesktopApp: () => null,
    resolveBaseUrl: () => null,
    classifyName: () => 'doc',
    openTarget: async (t, options) => {
      opened.push(t);
      openedOptions.push(options);
      return { ok: true };
    },
    findAncestorProject: () => null,
    isProjectRoot: () => true,
    enclosingProject: () => null,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    ...overrides,
  };
  return { deps, opened, openedOptions, logs, errors };
}

describe('runOpen', () => {
  test('doc with a desktop bundle → openknowledge:// deep link, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    const code = await runOpen('bim-brain/log', { project: '/abs/proj' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fabs%2Fproj&doc=bim-brain%2Flog']);
  });

  test('doc with a desktop bundle threads the verified bundle path to openTarget', async () => {
    const { deps, openedOptions } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    await runOpen('bim-brain/log', { project: '/abs/proj' }, deps);
    expect(openedOptions).toEqual([{ desktopBundlePath: '/Applications/OpenKnowledge.app' }]);
  });

  test('doc, no bundle but UI running → browser route, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
    });
    const code = await runOpen('specs/foo/SPEC', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/specs/foo/SPEC']);
  });

  test('launcher failure returns exit 1 without printing a success message', async () => {
    const { deps, logs, errors } = makeDeps({
      detectDesktopApp: () => null,
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
    expect(errors[0]).toContain('https://openknowledge.ai/download');
  });

  test('folder with a desktop bundle → folder= deep link, exit 0', async () => {
    const { deps, opened, openedOptions } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    const code = await runOpen('specs/foo/', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge://open?project=%2Fp&folder=specs%2Ffoo']);
    expect(openedOptions).toEqual([{ desktopBundlePath: '/Applications/OpenKnowledge.app' }]);
  });

  test('folder, no bundle but UI running → browser folder route, exit 0', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
    });
    const code = await runOpen('specs/foo/', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/specs/foo/']);
  });

  test('auto-detects a folder from disk (no trailing slash needed)', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
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
    const { deps, opened, openedOptions } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    const code = await runOpen('trip-log', { skill: true, project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual([
      'openknowledge://open?project=%2Fp&doc=__skill__%2Fproject%2Ftrip-log',
    ]);
    expect(openedOptions).toEqual([{ desktopBundlePath: '/Applications/OpenKnowledge.app' }]);
  });

  test('skill --scope global, no bundle but UI running → browser skill route', async () => {
    const { deps, opened } = makeDeps({ resolveBaseUrl: () => 'http://localhost:5173' });
    const code = await runOpen('trip-log', { skill: true, scope: 'global', project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['http://localhost:5173/#/__skill__/global/trip-log']);
  });

  test('skill with an invalid --scope → error, exit 1', async () => {
    const { deps, errors } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
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
    const { deps, opened, errors } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
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
  ])(
    'rejects names the desktop parser would drop (%s) instead of false success',
    async (_label, name) => {
      const { deps, opened, errors } = makeDeps({
        detectDesktopApp: () => STABLE_APP,
      });
      const code = await runOpen(name, { project: '/p' }, deps);
      expect(code).toBe(1);
      expect(opened).toEqual([]);
      expect(errors).toHaveLength(1);
    },
  );

  test('rejects unsafe folder names too', async () => {
    const { deps, opened, errors } = makeDeps({ resolveBaseUrl: () => 'http://localhost:5173' });
    const code = await runOpen('specs/..', { project: '/p' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('doc deep link encodes the whole name including the slash (%2F)', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
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
  test('detectDesktopApp collapses a bundlePath-absent DetectResult to null (the force-browser/no-bundle contract)', () => {
    const deps = createRealOpenDeps(() => ({
      available: false,
      reason: 'force-browser',
      cliProduct: 'stable',
    }));
    expect(deps.detectDesktopApp()).toBeNull();
  });

  test('detectDesktopApp returns the bundle path and Stable scheme when detect reports a Stable bundle', () => {
    const deps = createRealOpenDeps(() => ({
      available: true,
      reason: 'available',
      bundlePath: '/Applications/OpenKnowledge.app',
      product: 'stable',
      cliProduct: 'stable',
    }));
    expect(deps.detectDesktopApp()).toEqual(STABLE_APP);
  });

  test('detectDesktopApp returns the bundle path when available:false but bundlePath is set', () => {
    const deps = createRealOpenDeps(() => ({
      available: false,
      reason: 'headless',
      bundlePath: '/Applications/OpenKnowledge.app',
      product: 'stable',
      cliProduct: 'stable',
    }));
    expect(deps.detectDesktopApp()).toEqual(STABLE_APP);
  });

  test('detectDesktopApp carries the Beta scheme for a Beta bundle', () => {
    const deps = createRealOpenDeps(() => ({
      available: true,
      reason: 'available',
      bundlePath: '/Applications/OpenKnowledge Beta.app',
      product: 'beta',
      cliProduct: 'beta',
    }));
    expect(deps.detectDesktopApp()).toEqual(BETA_APP);
  });
});

describe('Beta desktop app', () => {
  const macBetaCli: DetectDeps = {
    platform: 'darwin',
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: '/Applications/OpenKnowledge Beta.app/Contents/MacOS/OpenKnowledge Beta',
    isTTY: true,
    statSync: () => null,
  };

  function withRealDetection(detect: () => DetectResult): ReturnType<typeof makeDeps> {
    const recorder = makeDeps();
    const { detectDesktopApp: _stubbed, ...stubs } = recorder.deps;
    return { ...recorder, deps: { ...createRealOpenDeps(detect), ...stubs } };
  }

  test('a doc deep link uses the Beta scheme so it reaches the Beta app', async () => {
    const { deps, opened, openedOptions } = makeDeps({ detectDesktopApp: () => BETA_APP });
    const code = await runOpen('notes/plan', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge-beta://open?project=%2Fp&doc=notes%2Fplan']);
    expect(openedOptions).toEqual([{ desktopBundlePath: BETA_APP.bundlePath }]);
  });

  test('folder and skill deep links use the Beta scheme', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => BETA_APP,
      classifyName: () => 'folder',
    });
    await runOpen('specs', { project: '/p' }, deps);
    await runOpen('trip-log', { project: '/p', skill: true }, deps);
    expect(opened).toEqual([
      'openknowledge-beta://open?project=%2Fp&folder=specs',
      'openknowledge-beta://open?project=%2Fp&doc=__skill__%2Fproject%2Ftrip-log',
    ]);
  });

  test('the bundled Beta CLI on macOS deep-links into the Beta app, not Stable', async () => {
    const { deps, opened, openedOptions } = withRealDetection(() => detectDesktop(macBetaCli));
    const code = await runOpen('notes/plan', { project: '/p' }, deps);
    expect(code).toBe(0);
    expect(opened).toEqual(['openknowledge-beta://open?project=%2Fp&doc=notes%2Fplan']);
    expect(openedOptions).toEqual([{ desktopBundlePath: BETA_APP.bundlePath }]);
  });

  test('the bundled Stable CLI keeps the Stable scheme', async () => {
    const { deps, opened } = withRealDetection(() =>
      detectDesktop({
        ...macBetaCli,
        execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      }),
    );
    await runOpen('notes/plan', { project: '/p' }, deps);
    expect(opened).toEqual(['openknowledge://open?project=%2Fp&doc=notes%2Fplan']);
  });
});

describe('resolved-project disclosure', () => {
  test('doc open names the absolute project root', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    const code = await runOpen('specs/foo/SPEC', { project: '/abs/proj' }, deps);
    expect(code).toBe(0);
    expect(logs).toContain('Project: /abs/proj');
  });

  test('folder open names the absolute project root', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => null,
      resolveBaseUrl: () => 'http://localhost:5173',
      classifyName: () => 'folder',
    });
    const code = await runOpen('specs/foo', { project: '/abs/proj' }, deps);
    expect(code).toBe(0);
    expect(logs).toContain('Project: /abs/proj');
  });

  test('skill open names the absolute project root', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
    });
    const code = await runOpen('my-skill', { skill: true, project: '/abs/proj' }, deps);
    expect(code).toBe(0);
    expect(logs).toContain('Project: /abs/proj');
  });

  test('a failed open discloses nothing (no false project claim)', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      openTarget: async () => ({ ok: false, reason: 'not-installed' }),
    });
    const code = await runOpen('doc', { project: '/abs/proj' }, deps);
    expect(code).toBe(1);
    expect(logs).toEqual([]);
  });

  test('a nested project root names BOTH roots, once', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      findAncestorProject: () => '/abs',
    });
    const code = await runOpen('doc', { project: '/abs/nested' }, deps);
    expect(code).toBe(0);
    const nested = logs.filter((l) => l.startsWith('Note:'));
    expect(nested).toHaveLength(1);
    expect(nested[0]).toContain('/abs/nested');
    expect(nested[0]).toContain('/abs');
  });

  test('a non-nested project root says nothing extra', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      findAncestorProject: () => null,
    });
    await runOpen('doc', { project: '/abs/proj' }, deps);
    expect(logs.filter((l) => l.startsWith('Note:'))).toHaveLength(0);
  });
});

describe('explicit --project validation', () => {
  test('refuses an override that does not name a project, without opening anything', async () => {
    const { deps, opened, errors } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      isProjectRoot: () => false,
    });
    const code = await runOpen('README', { project: '/tmp/not-a-project' }, deps);
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errors.join('\n')).toContain('not an OpenKnowledge project');
  });

  test('honors an override that does name a project', async () => {
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      isProjectRoot: () => true,
    });
    const code = await runOpen('README', { project: '/tmp/real-project' }, deps);
    expect(code).toBe(0);
    expect(opened[0]).toContain(encodeURIComponent('/tmp/real-project'));
  });

  test('an absent override keeps the cwd default and is never validated', async () => {
    let consulted = false;
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      isProjectRoot: () => {
        consulted = true;
        return false;
      },
    });
    const code = await runOpen('README', {}, deps);
    expect(code).toBe(0);
    expect(consulted).toBe(false);
    expect(logs.filter((l) => l.startsWith('Project:'))).toHaveLength(0);
    expect(logs.join('\n')).toContain('not an OpenKnowledge project');
  });
});

describe('running outside any project', () => {
  test('does not call the cwd fallback a project', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      enclosingProject: () => null,
    });
    const code = await runOpen('notes', {}, deps);
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith('Project:'))).toBe(false);
    expect(logs.some((l) => l.startsWith('Working directory:'))).toBe(true);
  });

  test('does not derive a nested-project note from a non-project directory', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      enclosingProject: () => null,
      findAncestorProject: () => '/repo/root',
    });
    await runOpen('notes', {}, deps);
    expect(logs.filter((l) => l.startsWith('Note:'))).toHaveLength(0);
  });
});

describe('running from a subdirectory of a project', () => {
  test('acts on the enclosing project, not the subdirectory it was run from', async () => {
    const { deps, opened, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      enclosingProject: () => '/repo/root',
      findAncestorProject: () => null,
    });
    const code = await runOpen('notes', {}, deps);
    expect(code).toBe(0);
    expect(opened[0]).toContain(encodeURIComponent('/repo/root'));
    expect(logs.join('\n')).toContain('/repo/root');
  });

  test('does not claim a nested topology just because it ran below the root', async () => {
    const { deps, logs } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      enclosingProject: () => '/repo/root',
      findAncestorProject: () => null,
    });
    await runOpen('notes', {}, deps);
    expect(logs.join('\n').toLowerCase()).not.toContain('nested');
  });

  test('an explicit --project is never overridden by the cwd lookup', async () => {
    let consulted = false;
    const { deps, opened } = makeDeps({
      detectDesktopApp: () => STABLE_APP,
      enclosingProject: () => {
        consulted = true;
        return '/repo/root';
      },
      isProjectRoot: () => true,
    });
    await runOpen('notes', { project: '/other/project' }, deps);
    expect(consulted).toBe(false);
    expect(opened[0]).toContain(encodeURIComponent('/other/project'));
  });
});
