import { describe, expect, test } from 'bun:test';
import {
  deriveAutoInstanceName,
  type GitInstanceContext,
  resolveEffectiveInstanceName,
} from './auto-instance.ts';

describe('deriveAutoInstanceName', () => {
  test('uses the branch name for a normal feature branch', () => {
    expect(deriveAutoInstanceName({ branch: 'theming-as-plugin', worktreeDir: '/repo' })).toBe(
      'theming-as-plugin',
    );
  });

  test('returns the branch verbatim (slash sanitizing happens downstream)', () => {
    expect(deriveAutoInstanceName({ branch: 'feat/foo', worktreeDir: '/repo' })).toBe('feat/foo');
  });

  test('skips the repo default branch so plain dev on main is unchanged', () => {
    expect(deriveAutoInstanceName({ branch: 'main', worktreeDir: '/repo' })).toBeNull();
    expect(deriveAutoInstanceName({ branch: 'master', worktreeDir: '/repo' })).toBeNull();
  });

  test('falls back to the worktree dir basename on detached HEAD', () => {
    expect(deriveAutoInstanceName({ branch: 'HEAD', worktreeDir: '/Users/me/wt/spike-a' })).toBe(
      'spike-a',
    );
    expect(deriveAutoInstanceName({ branch: null, worktreeDir: '/Users/me/wt/spike-b' })).toBe(
      'spike-b',
    );
  });

  test('returns null when neither branch nor worktree dir is usable', () => {
    expect(deriveAutoInstanceName({ branch: null, worktreeDir: null })).toBeNull();
    expect(deriveAutoInstanceName({ branch: 'HEAD', worktreeDir: null })).toBeNull();
  });
});

describe('resolveEffectiveInstanceName', () => {
  const gitOn = (ctx: GitInstanceContext) => ({ readGit: () => ctx });

  test('explicit OK_INSTANCE wins over git derivation', () => {
    expect(
      resolveEffectiveInstanceName(
        { OK_INSTANCE: 'work' },
        '/repo',
        gitOn({ branch: 'feat/x', worktreeDir: '/repo' }),
      ),
    ).toEqual({ name: 'work', source: 'env' });
  });

  test('explicit OK_INSTANCE isolates even on the default branch', () => {
    expect(
      resolveEffectiveInstanceName(
        { OK_INSTANCE: 'main' },
        '/repo',
        gitOn({ branch: 'main', worktreeDir: '/repo' }),
      ),
    ).toEqual({ name: 'main', source: 'env' });
  });

  test('blank OK_INSTANCE falls through to git derivation', () => {
    expect(
      resolveEffectiveInstanceName(
        { OK_INSTANCE: '   ' },
        '/repo',
        gitOn({ branch: 'feat/x', worktreeDir: '/repo' }),
      ),
    ).toEqual({ name: 'feat/x', source: 'git' });
  });

  test('derives from git when OK_INSTANCE is unset', () => {
    expect(
      resolveEffectiveInstanceName(
        {},
        '/repo',
        gitOn({ branch: 'theming-as-plugin', worktreeDir: '/repo' }),
      ),
    ).toEqual({ name: 'theming-as-plugin', source: 'git' });
  });

  test('OK_AUTO_INSTANCE=0/false/off disables auto-derivation', () => {
    for (const off of ['0', 'false', 'off', 'OFF']) {
      expect(
        resolveEffectiveInstanceName(
          { OK_AUTO_INSTANCE: off },
          '/repo',
          gitOn({ branch: 'feat/x', worktreeDir: '/repo' }),
        ),
      ).toBeNull();
    }
  });

  test('returns null on the default branch with no explicit override', () => {
    expect(
      resolveEffectiveInstanceName({}, '/repo', gitOn({ branch: 'main', worktreeDir: '/repo' })),
    ).toBeNull();
  });

  test('autoDeriveEnabled: false disables git derivation (E2E smoke) but explicit still wins', () => {
    const ctx = { branch: 'feat/x', worktreeDir: '/repo' };
    expect(
      resolveEffectiveInstanceName({}, '/repo', { ...gitOn(ctx), autoDeriveEnabled: false }),
    ).toBeNull();
    expect(
      resolveEffectiveInstanceName({ OK_INSTANCE: 'work' }, '/repo', {
        ...gitOn(ctx),
        autoDeriveEnabled: false,
      }),
    ).toEqual({ name: 'work', source: 'env' });
  });
});
