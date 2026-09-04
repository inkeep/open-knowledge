import { describe, expect, test } from 'vitest';
import { PROTOCOL_VERSION, RUNTIME_VERSION, STATE_SCHEMA_VERSION } from './version-constants.ts';

describe('version-constants', () => {
  test('RUNTIME_VERSION resolves from package.json (NOT the unknown sentinel)', () => {
    expect(RUNTIME_VERSION).not.toBe('0.0.0-unknown');
    expect(RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('PROTOCOL_VERSION is a positive integer', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test('STATE_SCHEMA_VERSION is a positive integer (schema-0 reserved as adoption sentinel)', () => {
    expect(typeof STATE_SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(STATE_SCHEMA_VERSION)).toBe(true);
    expect(STATE_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
