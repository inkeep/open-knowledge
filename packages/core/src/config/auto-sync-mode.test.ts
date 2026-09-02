import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PULL_INTERVAL_SECONDS,
  DEFAULT_PUSH_INTERVAL_SECONDS,
  isSyncMode,
  MAX_SYNC_INTERVAL_SECONDS,
  MIN_SYNC_INTERVAL_SECONDS,
  modeFromCommittedDefault,
  modeFromLegacyEnabled,
  resolveAutoSyncIntervals,
  resolveEffectiveAutoSyncMode,
  resolveLocalAutoSyncMode,
  SYNC_INTERVAL_PRESET_SECONDS,
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
    expect(resolveEffectiveAutoSyncMode({ local: { enabled: true }, committedDefault: null })).toBe(
      'full',
    );
    expect(
      resolveEffectiveAutoSyncMode({ local: { enabled: false }, committedDefault: null }),
    ).toBe('off');
    expect(resolveEffectiveAutoSyncMode({ local: {}, committedDefault: true })).toBe('full');
  });
});

describe('resolveAutoSyncIntervals', () => {
  test('absent leaves resolve to the shipped defaults', () => {
    for (const absent of [undefined, {}, { pullIntervalSeconds: null }]) {
      expect(resolveAutoSyncIntervals(absent)).toEqual({
        pullIntervalSeconds: DEFAULT_PULL_INTERVAL_SECONDS,
        pushIntervalSeconds: DEFAULT_PUSH_INTERVAL_SECONDS,
      });
    }
  });

  test('pull and push resolve independently', () => {
    expect(resolveAutoSyncIntervals({ pushIntervalSeconds: 900 })).toEqual({
      pullIntervalSeconds: DEFAULT_PULL_INTERVAL_SECONDS,
      pushIntervalSeconds: 900,
    });
    expect(resolveAutoSyncIntervals({ pullIntervalSeconds: 300 })).toEqual({
      pullIntervalSeconds: 300,
      pushIntervalSeconds: DEFAULT_PUSH_INTERVAL_SECONDS,
    });
  });

  test('a hand-edited out-of-range value clamps instead of failing the read', () => {
    expect(resolveAutoSyncIntervals({ pullIntervalSeconds: 1 }).pullIntervalSeconds).toBe(
      MIN_SYNC_INTERVAL_SECONDS,
    );
    expect(resolveAutoSyncIntervals({ pushIntervalSeconds: 999_999 }).pushIntervalSeconds).toBe(
      MAX_SYNC_INTERVAL_SECONDS,
    );
  });

  test('a non-finite or non-numeric value falls back rather than propagating NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'soon', {}, true]) {
      expect(
        resolveAutoSyncIntervals({ pullIntervalSeconds: bad as never }).pullIntervalSeconds,
      ).toBe(DEFAULT_PULL_INTERVAL_SECONDS);
    }
  });

  test('every offered preset survives resolution unchanged', () => {
    for (const seconds of SYNC_INTERVAL_PRESET_SECONDS) {
      expect(resolveAutoSyncIntervals({ pullIntervalSeconds: seconds }).pullIntervalSeconds).toBe(
        seconds,
      );
    }
  });

  test('the defaults are themselves offered as presets', () => {
    expect(SYNC_INTERVAL_PRESET_SECONDS).toContain(DEFAULT_PULL_INTERVAL_SECONDS);
    expect(SYNC_INTERVAL_PRESET_SECONDS).toContain(DEFAULT_PUSH_INTERVAL_SECONDS);
  });
});

describe('interval leaves degrade to the leaf, not the layer', () => {
  test('a hand-edited out-of-range interval keeps the rest of the project-local layer', async () => {
    const { ConfigSchema } = await import('./schema.ts');

    const parsed = ConfigSchema.safeParse({
      autoSync: { mode: 'off', pullIntervalSeconds: 15 },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(resolveLocalAutoSyncMode(parsed.data.autoSync)).toBe('off');
    expect(resolveAutoSyncIntervals(parsed.data.autoSync).pullIntervalSeconds).toBe(
      DEFAULT_PULL_INTERVAL_SECONDS,
    );
  });

  test('an in-range interval still parses through untouched', () => {
    expect(resolveAutoSyncIntervals({ pullIntervalSeconds: 300 }).pullIntervalSeconds).toBe(300);
  });
});
