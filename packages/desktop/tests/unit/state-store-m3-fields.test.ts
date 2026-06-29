import { describe, expect, test } from 'bun:test';
import { emptyState, parseAppState } from '../../src/main/state-store.ts';

describe('AppState M3 fields — defaults', () => {
  test('emptyState has the four M3 defaults', () => {
    const s = emptyState();
    expect(s.versionPendingInstall).toBeNull();
    expect(s.lastSeenVersion).toBeNull();
    expect(s.lastSuccessfulCheckAt).toBeNull();
    expect(s.stuckHintShown).toBe(false);
  });
});

describe('parseAppState M3 fields — coercion', () => {
  test('accepts a fully-populated M3 blob', () => {
    const raw = {
      recentProjects: [],
      lastOpenedProject: null,
      versionPendingInstall: '0.3.1',
      lastSeenVersion: '0.3.0',
      lastSuccessfulCheckAt: '2026-04-21T12:00:00.000Z',
      stuckHintShown: true,
    };
    const parsed = parseAppState(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.versionPendingInstall).toBe('0.3.1');
    expect(parsed?.lastSeenVersion).toBe('0.3.0');
    expect(parsed?.lastSuccessfulCheckAt).toBe('2026-04-21T12:00:00.000Z');
    expect(parsed?.stuckHintShown).toBe(true);
  });

  test('attemptedInstall: round-trips a string, coerces non-string + absent to null', () => {
    expect(
      parseAppState({ recentProjects: [], attemptedInstall: '0.16.0-beta.3' })?.attemptedInstall,
    ).toBe('0.16.0-beta.3');
    expect(
      parseAppState({ recentProjects: [], attemptedInstall: 42 })?.attemptedInstall,
    ).toBeNull();
    expect(parseAppState({ recentProjects: [] })?.attemptedInstall).toBeNull();
  });

  test('M1-forward-compat: pre-M3 blob without M3 keys returns valid state with defaults', () => {
    const raw = {
      recentProjects: [
        { path: '/tmp/m1-project', name: 'm1-project', lastOpenedAt: '2026-02-01T00:00:00Z' },
      ],
      lastOpenedProject: '/tmp/m1-project',
    };
    const parsed = parseAppState(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.recentProjects.length).toBe(1);
    expect(parsed?.lastOpenedProject).toBe('/tmp/m1-project');
    expect(parsed?.versionPendingInstall).toBeNull();
    expect(parsed?.lastSeenVersion).toBeNull();
    expect(parsed?.lastSuccessfulCheckAt).toBeNull();
    expect(parsed?.stuckHintShown).toBe(false);
  });

  test('coerces malformed M3 field types to defaults', () => {
    const raw = {
      recentProjects: [],
      lastOpenedProject: null,
      versionPendingInstall: 42, // not a string
      lastSeenVersion: { major: 0, minor: 3 }, // object
      lastSuccessfulCheckAt: true, // boolean
      stuckHintShown: 'yes', // string — only the literal `true` counts
    };
    const parsed = parseAppState(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.versionPendingInstall).toBeNull();
    expect(parsed?.lastSeenVersion).toBeNull();
    expect(parsed?.lastSuccessfulCheckAt).toBeNull();
    expect(parsed?.stuckHintShown).toBe(false);
  });

  test('stuckHintShown accepts only literal true — any other truthy value coerces to false', () => {
    const variants: Array<{ input: unknown; expected: boolean }> = [
      { input: true, expected: true },
      { input: false, expected: false },
      { input: 1, expected: false }, // defensive: truthy number is still not bool-true
      { input: 'true', expected: false },
      { input: null, expected: false },
      { input: undefined, expected: false },
    ];
    for (const { input, expected } of variants) {
      const parsed = parseAppState({
        recentProjects: [],
        lastOpenedProject: null,
        stuckHintShown: input,
      });
      expect(parsed?.stuckHintShown).toBe(expected);
    }
  });
});
