import { describe, expect, test } from 'bun:test';
import { type BridgeWorktreeEntry, parseWorktreeListPorcelain } from './worktree-list-parser.ts';

describe('parseWorktreeListPorcelain', () => {
  test('returns [] for empty input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
  });

  test('parses the canonical three-worktree example from the SPEC', () => {
    const stdout = [
      'worktree /Users/.../agents-private',
      'HEAD fafcada463abc',
      'branch refs/heads/main',
      '',
      'worktree /Users/.../agents-private/.claude/worktrees/feat-bar',
      'HEAD 89823101dabc',
      'branch refs/heads/feat-bar',
      'locked',
      '',
      'worktree /Users/.../agents-private/.claude/worktrees/abandoned',
      'HEAD deadbeef',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const entries = parseWorktreeListPorcelain(stdout);
    expect(entries).toEqual([
      {
        path: '/Users/.../agents-private',
        branch: 'main',
        headSha: 'fafcada463abc',
        locked: false,
        prunable: false,
      },
      {
        path: '/Users/.../agents-private/.claude/worktrees/feat-bar',
        branch: 'feat-bar',
        headSha: '89823101dabc',
        locked: true,
        prunable: false,
      },
      {
        path: '/Users/.../agents-private/.claude/worktrees/abandoned',
        branch: null,
        headSha: 'deadbeef',
        locked: false,
        prunable: true,
      },
    ] satisfies BridgeWorktreeEntry[]);
  });

  test('detached HEAD with no branch line yields branch: null', () => {
    const stdout = ['worktree /repo', 'HEAD abc123', 'detached', ''].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/repo', branch: null, headSha: 'abc123', locked: false, prunable: false },
    ]);
  });

  test('locked with optional reason on the same line still parses (reason ignored)', () => {
    const stdout = [
      'worktree /repo/wt',
      'HEAD abc123',
      'branch refs/heads/feat',
      'locked agent is mid-merge',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/repo/wt', branch: 'feat', headSha: 'abc123', locked: true, prunable: false },
    ]);
  });

  test('slashed branch names round-trip exactly (FR11)', () => {
    const stdout = ['worktree /repo/wt', 'HEAD abc123', 'branch refs/heads/feat/foo/bar', ''].join(
      '\n',
    );
    expect(parseWorktreeListPorcelain(stdout)[0]?.branch).toBe('feat/foo/bar');
  });

  test('branch line without refs/heads/ prefix is returned verbatim', () => {
    // git always emits the prefix, but be tolerant of variant tooling
    const stdout = ['worktree /repo', 'HEAD abc', 'branch some-other-ref', ''].join('\n');
    expect(parseWorktreeListPorcelain(stdout)[0]?.branch).toBe('some-other-ref');
  });

  test('multiple consecutive blank lines do not produce empty entries', () => {
    const stdout = [
      'worktree /a',
      'HEAD a1',
      'branch refs/heads/main',
      '',
      '',
      '',
      'worktree /b',
      'HEAD b1',
      'branch refs/heads/feat',
      '',
    ].join('\n');
    const entries = parseWorktreeListPorcelain(stdout);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(['/a', '/b']);
  });

  test('unknown keys are silently ignored (forward-compat)', () => {
    const stdout = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      'future-flag-not-yet-defined some-value',
      'mystery-attribute',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/repo', branch: 'main', headSha: 'abc', locked: false, prunable: false },
    ]);
  });

  test('block missing a worktree path is dropped without throwing', () => {
    const stdout = ['worktree', 'HEAD orphan', 'branch refs/heads/x', ''].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([]);
  });

  test('lines that appear before any worktree key are silently dropped', () => {
    const stdout = [
      'HEAD stray',
      'branch refs/heads/stray',
      '',
      'worktree /real',
      'HEAD abc',
      'branch refs/heads/main',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/real', branch: 'main', headSha: 'abc', locked: false, prunable: false },
    ]);
  });

  test('trailing entry without a blank-line terminator still parses', () => {
    const stdout = [
      'worktree /a',
      'HEAD a1',
      'branch refs/heads/main',
      '',
      'worktree /b',
      'HEAD b1',
      'branch refs/heads/feat',
      // no trailing blank line
    ].join('\n');
    const entries = parseWorktreeListPorcelain(stdout);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      path: '/b',
      branch: 'feat',
      headSha: 'b1',
      locked: false,
      prunable: false,
    });
  });

  test('CRLF line endings (Windows-style) parse the same as LF', () => {
    const stdout = ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', ''].join('\r\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/repo', branch: 'main', headSha: 'abc', locked: false, prunable: false },
    ]);
  });

  test('detached overrides a preceding branch line within the same block (defensive)', () => {
    // git won't emit both, but we don't trust the wire — the explicit
    // `detached` token wins.
    const stdout = ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', 'detached', ''].join(
      '\n',
    );
    expect(parseWorktreeListPorcelain(stdout)[0]?.branch).toBeNull();
  });

  test('new worktree line implicitly terminates the previous block (missing blank-line separator)', () => {
    const stdout = [
      'worktree /a',
      'HEAD a1',
      'branch refs/heads/main',
      // no blank line
      'worktree /b',
      'HEAD b1',
      'branch refs/heads/feat',
      '',
    ].join('\n');
    const entries = parseWorktreeListPorcelain(stdout);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(['/a', '/b']);
  });

  test('HEAD line with no SHA value yields null headSha', () => {
    const stdout = ['worktree /repo', 'HEAD', 'branch refs/heads/main', ''].join('\n');
    expect(parseWorktreeListPorcelain(stdout)[0]?.headSha).toBeNull();
  });

  test('blocks with only a worktree line still emit (branch=null, headSha=null)', () => {
    const stdout = ['worktree /repo', ''].join('\n');
    expect(parseWorktreeListPorcelain(stdout)).toEqual([
      { path: '/repo', branch: null, headSha: null, locked: false, prunable: false },
    ]);
  });

  test('path with spaces is preserved (git emits raw path; no escaping)', () => {
    // git does not escape paths in --porcelain output today; spaces survive
    const stdout = [
      'worktree /Users/My Documents/repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
    ].join('\n');
    expect(parseWorktreeListPorcelain(stdout)[0]?.path).toBe('/Users/My Documents/repo');
  });
});
