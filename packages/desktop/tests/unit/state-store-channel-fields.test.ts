import { describe, expect, test } from 'bun:test';
import {
  CURRENT_SCHEMA_VERSION,
  emptyState,
  evaluateSchemaCompatibility,
  MAX_SUPPORTED_SCHEMA_VERSION,
  parseAppState,
} from '../../src/main/state-store.ts';

describe('AppState schema-version field — defaults', () => {
  test('emptyState defaults schemaVersion to CURRENT_SCHEMA_VERSION', () => {
    expect(emptyState().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('emptyState has no updateChannel field', () => {
    expect((emptyState() as Record<string, unknown>).updateChannel).toBeUndefined();
  });

  test('CURRENT_SCHEMA_VERSION === MAX_SUPPORTED_SCHEMA_VERSION today', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(MAX_SUPPORTED_SCHEMA_VERSION);
  });
});

describe('parseAppState — legacy updateChannel tolerance', () => {
  test('silently drops a legacy `updateChannel: "beta"` value', () => {
    const parsed = parseAppState({
      recentProjects: [{ path: '/tmp/p', name: 'p', lastOpenedAt: '2026-04-01T00:00:00Z' }],
      lastOpenedProject: '/tmp/p',
      updateChannel: 'beta',
      schemaVersion: 1,
    });
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>).updateChannel).toBeUndefined();
    expect(parsed?.recentProjects.length).toBe(1);
    expect(parsed?.schemaVersion).toBe(1);
  });

  test('silently drops a legacy `updateChannel: "latest"` value', () => {
    const parsed = parseAppState({
      recentProjects: [],
      lastOpenedProject: null,
      updateChannel: 'latest',
    });
    expect((parsed as unknown as Record<string, unknown>).updateChannel).toBeUndefined();
  });

  test('a state.json with no updateChannel key still parses cleanly', () => {
    const parsed = parseAppState({
      recentProjects: [{ path: '/tmp/p', name: 'p', lastOpenedAt: '2026-04-01T00:00:00Z' }],
      lastOpenedProject: '/tmp/p',
    });
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>).updateChannel).toBeUndefined();
  });

  test('a parsed AppState round-trips back to disk without an updateChannel key', () => {
    const parsed = parseAppState({
      recentProjects: [],
      lastOpenedProject: null,
      updateChannel: 'beta',
    });
    const reSerialized = JSON.parse(JSON.stringify(parsed));
    expect(reSerialized.updateChannel).toBeUndefined();
  });

  test('preserves a future schemaVersion verbatim — boot-side check decides what to do', () => {
    const parsed = parseAppState({
      recentProjects: [],
      lastOpenedProject: null,
      schemaVersion: 999,
    });
    expect(parsed?.schemaVersion).toBe(999);
  });

  test('coerces non-integer schemaVersion to 1', () => {
    const variants: unknown[] = [null, '1', 1.5, NaN, true];
    for (const input of variants) {
      const parsed = parseAppState({
        recentProjects: [],
        lastOpenedProject: null,
        schemaVersion: input,
      });
      expect(parsed?.schemaVersion).toBe(1);
    }
  });
});

describe('evaluateSchemaCompatibility — boot-time refuse-downgrade gate', () => {
  test('returns ok when schemaVersion equals max supported (today)', () => {
    const result = evaluateSchemaCompatibility(
      { schemaVersion: MAX_SUPPORTED_SCHEMA_VERSION },
      MAX_SUPPORTED_SCHEMA_VERSION,
      '0.4.0',
    );
    expect(result.status).toBe('ok');
  });

  test('returns ok when schemaVersion is below max supported (future migration window)', () => {
    const result = evaluateSchemaCompatibility({ schemaVersion: 1 }, 2, '0.5.0');
    expect(result.status).toBe('ok');
  });

  test('returns incompatible with diagnostic when schemaVersion exceeds max supported', () => {
    const result = evaluateSchemaCompatibility(
      { schemaVersion: 999 },
      MAX_SUPPORTED_SCHEMA_VERSION,
      '0.4.0',
    );
    expect(result.status).toBe('incompatible');
    if (result.status === 'incompatible') {
      expect(result.diagnostic).toEqual({
        currentBuild: '0.4.0',
        persistedSchemaVersion: 999,
        maxSupported: MAX_SUPPORTED_SCHEMA_VERSION,
      });
    }
  });

  test('boundary: schemaVersion === max + 1 is incompatible', () => {
    const result = evaluateSchemaCompatibility({ schemaVersion: 2 }, 1, '0.4.0');
    expect(result.status).toBe('incompatible');
  });

  test('CURRENT and MAX both 1 today means a fresh persisted state is always ok', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeLessThanOrEqual(MAX_SUPPORTED_SCHEMA_VERSION);
  });
});
