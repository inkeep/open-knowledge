import { describe, expect, test } from 'vitest';
import {
  isSyncMode,
  modeFromCommittedDefault,
  modeFromLegacyEnabled,
  resolveEffectiveAutoSyncMode,
  resolveLocalAutoSyncMode,
  SYNC_MODE_CHANGE_SOURCES,
  SYNC_MODES,
} from './auto-sync-mode.ts';

describe('isSyncMode', () => {
  test('accepts the three modes and nothing else', () => {
    expect(SYNC_MODES).toEqual(['off', 'follow', 'full']);
    for (const mode of SYNC_MODES) expect(isSyncMode(mode)).toBe(true);
    for (const other of ['on', 'sideways', '', 'FULL', null, undefined, true, 1]) {
      expect(isSyncMode(other)).toBe(false);
    }
  });
});

describe('SYNC_MODE_CHANGE_SOURCES', () => {
  test('is the bounded telemetry vocabulary and nothing else', () => {
    expect(SYNC_MODE_CHANGE_SOURCES).toEqual(['config', 'committed-default', 'worktree-inherit']);
  });
});

describe('modeFromLegacyEnabled', () => {
  test('true derives to full (bidirectional sync)', () => {
    expect(modeFromLegacyEnabled(true)).toBe('full');
  });

  test('false derives to off', () => {
    expect(modeFromLegacyEnabled(false)).toBe('off');
  });

  test('null/undefined stays unanswered (never asked)', () => {
    expect(modeFromLegacyEnabled(null)).toBeNull();
    expect(modeFromLegacyEnabled(undefined)).toBeNull();
  });
});

describe('modeFromCommittedDefault', () => {
  test('accepts the widened mode strings verbatim', () => {
    expect(modeFromCommittedDefault('off')).toBe('off');
    expect(modeFromCommittedDefault('follow')).toBe('follow');
    // Legacy alias: a committed 'pull' resolves to 'follow'.
    expect(modeFromCommittedDefault('pull')).toBe('follow');
    expect(modeFromCommittedDefault('full')).toBe('full');
  });

  test('translates the legacy boolean seed', () => {
    expect(modeFromCommittedDefault(true)).toBe('full');
    expect(modeFromCommittedDefault(false)).toBe('off');
  });

  test('null/undefined means no committed default', () => {
    expect(modeFromCommittedDefault(null)).toBeNull();
    expect(modeFromCommittedDefault(undefined)).toBeNull();
  });
});

describe('resolveLocalAutoSyncMode', () => {
  test('an explicit mode wins over the legacy enabled boolean', () => {
    expect(resolveLocalAutoSyncMode({ mode: 'follow', enabled: true })).toBe('follow');
    // Legacy alias: a stored 'pull' resolves to 'follow'.
    expect(resolveLocalAutoSyncMode({ mode: 'pull', enabled: true })).toBe('follow');
    expect(resolveLocalAutoSyncMode({ mode: 'off', enabled: true })).toBe('off');
  });

  test('with no mode key, derives from the legacy enabled boolean', () => {
    expect(resolveLocalAutoSyncMode({ enabled: true })).toBe('full');
    expect(resolveLocalAutoSyncMode({ enabled: false })).toBe('off');
  });

  test('a null mode falls through to the legacy derive (mode absent === unanswered)', () => {
    expect(resolveLocalAutoSyncMode({ mode: null, enabled: true })).toBe('full');
  });

  test('both absent, and a fully absent object, are unanswered', () => {
    expect(resolveLocalAutoSyncMode({ mode: null, enabled: null })).toBeNull();
    expect(resolveLocalAutoSyncMode({})).toBeNull();
    expect(resolveLocalAutoSyncMode(undefined)).toBeNull();
  });
});

describe('resolveEffectiveAutoSyncMode', () => {
  test('a non-null per-machine choice wins over the committed default', () => {
    expect(resolveEffectiveAutoSyncMode({ local: { mode: 'off' }, committedDefault: 'full' })).toBe(
      'off',
    );
    expect(
      resolveEffectiveAutoSyncMode({ local: { enabled: false }, committedDefault: true }),
    ).toBe('off');
  });

  test('unanswered locally falls back to the committed default', () => {
    expect(
      resolveEffectiveAutoSyncMode({
        local: { mode: null, enabled: null },
        committedDefault: 'follow',
      }),
    ).toBe('follow');
    expect(resolveEffectiveAutoSyncMode({ local: undefined, committedDefault: true })).toBe('full');
  });

  test('unanswered everywhere resolves to null (onboarding prompts)', () => {
    expect(resolveEffectiveAutoSyncMode({ local: {}, committedDefault: null })).toBeNull();
    expect(
      resolveEffectiveAutoSyncMode({ local: undefined, committedDefault: undefined }),
    ).toBeNull();
  });

  test('legacy-only config round-trips to the pre-mode behavior', () => {
    // enabled:true → full (sync on); enabled:false → off; committed default:true seeds full.
    expect(resolveEffectiveAutoSyncMode({ local: { enabled: true }, committedDefault: null })).toBe(
      'full',
    );
    expect(
      resolveEffectiveAutoSyncMode({ local: { enabled: false }, committedDefault: null }),
    ).toBe('off');
    expect(resolveEffectiveAutoSyncMode({ local: {}, committedDefault: true })).toBe('full');
  });
});
