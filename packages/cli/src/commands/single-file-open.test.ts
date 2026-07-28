import {
  SingleFileNotFoundError,
  SingleFileNotMarkdownError,
  type SingleFileOpenPlan,
} from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { runSingleFileOpen, type SingleFileOpenDeps } from './single-file-open.ts';

interface Recorder {
  openTargets: string[];
  projectOpens: Array<{ docName: string; projectRoot: string }>;
  browserOpens: Array<Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>>;
  logs: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<SingleFileOpenDeps> & { plan?: SingleFileOpenPlan; planThrows?: Error },
): { deps: SingleFileOpenDeps; rec: Recorder } {
  const rec: Recorder = {
    openTargets: [],
    projectOpens: [],
    browserOpens: [],
    logs: [],
    errors: [],
  };
  const deps: SingleFileOpenDeps = {
    prepare: () => {
      if (overrides.planThrows) throw overrides.planThrows;
      if (!overrides.plan) throw new Error('no plan configured');
      return overrides.plan;
    },
    detectBundlePath: overrides.detectBundlePath ?? (() => null),
    openTarget: (t) => rec.openTargets.push(t),
    runProjectOpen: (docName, projectRoot) => {
      rec.projectOpens.push({ docName, projectRoot });
      return 0;
    },
    runBrowserOpen: async (plan) => {
      rec.browserOpens.push(plan);
    },
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
    expect(rec.browserOpens).toHaveLength(0);
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
