import {
  type PrepareSingleFileOpenOptions,
  SingleFileNotFoundError,
  SingleFileNotMarkdownError,
  type SingleFileOpenPlan,
  SingleFileProjectOverrideError,
} from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import type { OpenTargetOptions } from '../utils/open-target.ts';
import { runSingleFileOpen, type SingleFileOpenDeps } from './single-file-open.ts';

interface Recorder {
  prepareOptions: Array<PrepareSingleFileOpenOptions | undefined>;
  openTargets: string[];
  openTargetOptions: Array<Pick<OpenTargetOptions, 'desktopBundlePath'> | undefined>;
  projectOpens: Array<{ docName: string; projectRoot: string }>;
  browserOpens: Array<Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>>;
  logs: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<SingleFileOpenDeps> & { plan?: SingleFileOpenPlan; planThrows?: Error },
): { deps: SingleFileOpenDeps; rec: Recorder } {
  const rec: Recorder = {
    prepareOptions: [],
    openTargets: [],
    openTargetOptions: [],
    projectOpens: [],
    browserOpens: [],
    logs: [],
    errors: [],
  };
  const deps: SingleFileOpenDeps = {
    prepare: (_filePath, options) => {
      rec.prepareOptions.push(options);
      if (overrides.planThrows) throw overrides.planThrows;
      if (!overrides.plan) throw new Error('no plan configured');
      return overrides.plan;
    },
    detectBundlePath: overrides.detectBundlePath ?? (() => null),
    openTarget:
      overrides.openTarget ??
      (async (t, options) => {
        rec.openTargets.push(t);
        rec.openTargetOptions.push(options);
        return { ok: true };
      }),
    runProjectOpen:
      overrides.runProjectOpen ??
      (async (docName, projectRoot) => {
        rec.projectOpens.push({ docName, projectRoot });
        return 0;
      }),
    runBrowserOpen:
      overrides.runBrowserOpen ??
      (async (plan) => {
        rec.browserOpens.push(plan);
      }),
    log: (m) => rec.logs.push(m),
    error: (m) => rec.errors.push(m),
  };
  return { deps, rec };
}

const projectPlan: SingleFileOpenPlan = {
  mode: 'project',
  projectRoot: '/proj',
  docName: 'sub/spec',
  canonicalFilePath: '/proj/sub/spec.md',
};
const ephemeralPlan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }> = {
  mode: 'ephemeral',
  canonicalFilePath: '/Users/me/notes/todo.md',
  contentDir: '/Users/me/notes',
  singleDocRelPath: 'todo.md',
  docName: 'todo',
};

describe('runSingleFileOpen', () => {
  test('project mode reuses the `ok open` project path', async () => {
    const { deps, rec } = makeDeps({ plan: projectPlan });
    const code = await runSingleFileOpen('/proj/sub/spec.md', deps);
    expect(code).toBe(0);
    expect(rec.projectOpens).toEqual([{ docName: 'sub/spec', projectRoot: '/proj' }]);
    expect(rec.browserOpens).toHaveLength(0);
    expect(rec.openTargets).toHaveLength(0);
  });

  test('ephemeral mode with a desktop bundle deep-links the file to the app', async () => {
    const { deps, rec } = makeDeps({
      plan: ephemeralPlan,
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
    });
    const code = await runSingleFileOpen('/Users/me/notes/todo.md', deps);
    expect(code).toBe(0);
    expect(rec.openTargets).toEqual([
      `openknowledge://open?file=${encodeURIComponent('/Users/me/notes/todo.md')}`,
    ]);
    // The dispatcher (open-target.ts) names this exact bundle directly on
    // darwin instead of resolving the openknowledge:// scheme through Launch
    // Services — verified path threaded through, not re-derived.
    expect(rec.openTargetOptions).toEqual([
      { desktopBundlePath: '/Applications/OpenKnowledge.app' },
    ]);
    expect(rec.browserOpens).toHaveLength(0);
  });

  test('ephemeral mode reports launcher failures as exit code 1', async () => {
    const { deps, rec } = makeDeps({
      plan: ephemeralPlan,
      detectBundlePath: () => '/Applications/OpenKnowledge.app',
      openTarget: async () => ({ ok: false, reason: 'not-installed' }),
    });

    const code = await runSingleFileOpen('/Users/me/notes/todo.md', deps);

    expect(code).toBe(1);
    expect(rec.logs).toHaveLength(0);
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]).toContain('is not installed or cannot be executed');
  });

  test('ephemeral mode with no desktop bundle falls back to the browser session', async () => {
    const { deps, rec } = makeDeps({ plan: ephemeralPlan, detectBundlePath: () => null });
    await runSingleFileOpen('/Users/me/notes/todo.md', deps);
    expect(rec.browserOpens).toEqual([ephemeralPlan]);
    expect(rec.openTargets).toHaveLength(0);
  });

  test('a missing file renders a clean error + exit code 1 (no throw)', async () => {
    const { deps, rec } = makeDeps({ planThrows: new SingleFileNotFoundError('/x/nope.md') });
    const code = await runSingleFileOpen('/x/nope.md', deps);
    expect(code).toBe(1);
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]).toContain('File not found');
  });

  test('a non-markdown file renders a clean error + exit code 1', async () => {
    const { deps, rec } = makeDeps({ planThrows: new SingleFileNotMarkdownError('/x/notes.txt') });
    const code = await runSingleFileOpen('/x/notes.txt', deps);
    expect(code).toBe(1);
    expect(rec.errors[0]).toContain('markdown');
  });

  test('an unexpected (non-typed) error propagates', async () => {
    const { deps } = makeDeps({ planThrows: new Error('disk on fire') });
    await expect(runSingleFileOpen('/x/notes.md', deps)).rejects.toThrow('disk on fire');
  });
});

describe('runSingleFileOpen with an explicit --project override', () => {
  test('passes the named root through to the shared preparation step', async () => {
    const { deps, rec } = makeDeps({ plan: projectPlan });
    const code = await runSingleFileOpen('/proj/sub/spec.md', deps, { projectRoot: '/named' });
    expect(code).toBe(0);
    expect(rec.prepareOptions).toEqual([{ projectRoot: '/named' }]);
    expect(rec.projectOpens).toEqual([{ docName: 'sub/spec', projectRoot: '/proj' }]);
  });

  test('an override that cannot be honored exits non-zero with the reason', async () => {
    const { deps, rec } = makeDeps({
      planThrows: new SingleFileProjectOverrideError('/named', 'no .ok/config.yml there'),
    });
    const code = await runSingleFileOpen('/x/notes.md', deps, { projectRoot: '/named' });
    expect(code).toBe(1);
    expect(rec.errors[0]).toContain('/named');
    expect(rec.errors[0]).toContain('no .ok/config.yml there');
    expect(rec.projectOpens).toEqual([]);
    expect(rec.openTargets).toEqual([]);
  });

  test('no override → prepare is called without a root (ancestor walk decides)', async () => {
    const { deps, rec } = makeDeps({ plan: projectPlan });
    await runSingleFileOpen('/proj/sub/spec.md', deps);
    expect(rec.prepareOptions).toEqual([{ projectRoot: undefined }]);
  });
});
