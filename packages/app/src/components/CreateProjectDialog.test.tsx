/**
 * CreateProjectDialog — pure-helper tests.
 *
 * What this file pins (and only this):
 *   1. `joinPathPreview`, `basenamePreview`, `computeCascade`,
 *      `parseCreateNewError` — the four pure helpers that drive the caption,
 *      the banner, and the submit-error inline copy.
 *   2. Module-shape guards — named exports.
 *
 * Runtime form/button/editor wiring lives in
 * `CreateProjectDialog.runtime.dom.test.tsx`; cascade effect behavior lives
 * in `CreateProjectDialog.cascade-staleness.dom.test.tsx`.
 */
import { describe, expect, test } from 'bun:test';
import {
  basenamePreview,
  CreateProjectDialog,
  computeCascade,
  joinPathPreview,
  parseCreateNewError,
} from './CreateProjectDialog';

describe('joinPathPreview', () => {
  test('joins parent + name with forward slash by default', () => {
    expect(joinPathPreview('/Users/me/Projects', 'Foo')).toBe('/Users/me/Projects/Foo');
  });

  test('drops trailing slash on parent', () => {
    expect(joinPathPreview('/Users/me/Projects/', 'Foo')).toBe('/Users/me/Projects/Foo');
    expect(joinPathPreview('/Users/me/Projects//', 'Foo')).toBe('/Users/me/Projects/Foo');
  });

  test('uses backslash on Windows-style parents', () => {
    expect(joinPathPreview('C:\\Users\\me', 'Foo')).toBe('C:\\Users\\me\\Foo');
  });

  test('returns empty string when either side is empty', () => {
    expect(joinPathPreview('', 'Foo')).toBe('');
    expect(joinPathPreview('/Users/me', '')).toBe('');
    expect(joinPathPreview('', '')).toBe('');
  });
});

describe('basenamePreview', () => {
  test('extracts the trailing component from a POSIX path', () => {
    expect(basenamePreview('/Users/me/Projects/Foo')).toBe('Foo');
  });

  test('extracts the trailing component from a Windows path', () => {
    // Forward-compat: a future Windows port can deliver backslash-shaped
    // rootPaths over IPC; the basename helper must not return the whole path.
    expect(basenamePreview('C:\\Users\\me\\Projects\\Foo')).toBe('Foo');
  });

  test('tolerates trailing separators', () => {
    expect(basenamePreview('/Users/me/Projects/Foo/')).toBe('Foo');
    expect(basenamePreview('C:\\Users\\me\\Foo\\')).toBe('Foo');
  });

  test('returns the input unchanged when there is no separator', () => {
    expect(basenamePreview('Foo')).toBe('Foo');
  });

  test('returns empty string for empty input', () => {
    expect(basenamePreview('')).toBe('');
  });
});

describe('computeCascade', () => {
  const baseInput = {
    parent: '/Users/me/Projects',
    sanitizedName: 'Foo',
    enclosingProject: null,
    enclosingGit: null,
    targetState: null,
  };

  test('idle when parent or name is empty', () => {
    expect(computeCascade({ ...baseInput, parent: '' })).toEqual({ kind: 'idle' });
    expect(computeCascade({ ...baseInput, sanitizedName: '' })).toEqual({ kind: 'idle' });
  });

  test('block-nested wins over all other branches', () => {
    expect(
      computeCascade({
        ...baseInput,
        enclosingProject: { rootPath: '/Users/me/parent-proj', distance: 1 },
        enclosingGit: { gitRoot: '/Users/me', distance: 2 },
        targetState: 'exists-nonempty',
      }),
    ).toEqual({ kind: 'block-nested', rootPath: '/Users/me/parent-proj' });
  });

  test('confirm-git fires when an enclosing git root exists distinct from parent', () => {
    expect(
      computeCascade({
        ...baseInput,
        enclosingGit: { gitRoot: '/Users/me/repo', distance: 1 },
        targetState: 'free',
      }),
    ).toEqual({ kind: 'confirm-git', gitRoot: '/Users/me/repo' });
  });

  test('confirm-git fires when parent IS the git root (banner explains content-dir alignment)', () => {
    // After the content-dir alignment change, picking a git root directly
    // still results in `.ok/config.yml` landing at the git root (one level
    // UP from the new target folder `<parent>/<name>`), and content.dir
    // defaults to the git root. The on-disk consequence is identical to
    // the "parent is below git root" case, so the banner fires in both
    // shapes — users should not be silently surprised by where the project
    // file lands or what scope is tracked.
    expect(
      computeCascade({
        ...baseInput,
        enclosingGit: { gitRoot: '/Users/me/Projects', distance: 0 },
        targetState: 'free',
      }),
    ).toEqual({ kind: 'confirm-git', gitRoot: '/Users/me/Projects' });
  });

  test('block-nonempty fires when target exists with content', () => {
    expect(
      computeCascade({
        ...baseInput,
        targetState: 'exists-nonempty',
      }),
    ).toEqual({ kind: 'block-nonempty' });
  });

  test('exists-empty is treated as free (manual mkdir retry case)', () => {
    expect(
      computeCascade({
        ...baseInput,
        targetState: 'exists-empty',
      }),
    ).toEqual({ kind: 'free' });
  });

  test('free when all probes return null / free', () => {
    expect(
      computeCascade({
        ...baseInput,
        targetState: 'free',
      }),
    ).toEqual({ kind: 'free' });
  });

  test('targetState null (probes not yet returned) treated as free', () => {
    expect(computeCascade({ ...baseInput, targetState: null })).toEqual({ kind: 'free' });
  });
});

describe('parseCreateNewError', () => {
  test('matches nested-project prefix', () => {
    const e = new Error('nested-project: Cannot create a project inside an existing project: /foo');
    expect(parseCreateNewError(e)).toEqual({ reason: 'nested-project' });
  });

  test('matches target-not-empty prefix', () => {
    const e = new Error('target-not-empty: Target folder is not empty: /foo/bar');
    expect(parseCreateNewError(e)).toEqual({ reason: 'target-not-empty' });
  });

  test('matches invalid-args / mkdir-failed / git-init-failed / init-failed / discovery-failed', () => {
    expect(parseCreateNewError(new Error('invalid-args: name is empty'))).toMatchObject({
      reason: 'invalid-args',
    });
    expect(parseCreateNewError(new Error('mkdir-failed: EACCES'))).toMatchObject({
      reason: 'mkdir-failed',
    });
    expect(parseCreateNewError(new Error('git-init-failed: git not on PATH'))).toMatchObject({
      reason: 'git-init-failed',
    });
    expect(parseCreateNewError(new Error('init-failed: write error'))).toMatchObject({
      reason: 'init-failed',
    });
    expect(parseCreateNewError(new Error('discovery-failed: realpath EACCES'))).toMatchObject({
      reason: 'discovery-failed',
    });
  });

  test('falls through to unknown with verbatim message', () => {
    expect(parseCreateNewError(new Error('weird unexpected thing'))).toEqual({
      reason: 'unknown',
      message: 'weird unexpected thing',
    });
  });

  test('handles non-Error throwables', () => {
    expect(parseCreateNewError('plain string')).toEqual({
      reason: 'unknown',
      message: 'plain string',
    });
  });
});

describe('CreateProjectDialog module', () => {
  test('exports component as a named function', () => {
    expect(typeof CreateProjectDialog).toBe('function');
  });

  test('exports named pure helpers', async () => {
    const mod = await import('./CreateProjectDialog');
    expect(typeof mod.CreateProjectDialog).toBe('function');
    expect(typeof mod.computeCascade).toBe('function');
    expect(typeof mod.joinPathPreview).toBe('function');
    expect(typeof mod.basenamePreview).toBe('function');
    expect(typeof mod.parseCreateNewError).toBe('function');
  });
});
