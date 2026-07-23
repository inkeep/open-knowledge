import { describe, expect, it } from 'vitest';
import { isEntryPoint } from './entry-point.ts';

describe('isEntryPoint', () => {
  it('accepts every literal value in the EntryPoint union', () => {
    expect(isEntryPoint('create-new')).toBe(true);
    expect(isEntryPoint('create-new-nested-redirect')).toBe(true);
    expect(isEntryPoint('pick-existing')).toBe(true);
    expect(isEntryPoint('recents')).toBe(true);
    expect(isEntryPoint('deep-link')).toBe(true);
    expect(isEntryPoint('drag-drop')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isEntryPoint('start-fresh')).toBe(false);
    expect(isEntryPoint('')).toBe(false);
    expect(isEntryPoint('Create-New')).toBe(false);
    expect(isEntryPoint('__proto__')).toBe(false);
  });

  it('rejects non-string inputs (defends the IPC boundary against arbitrary payloads)', () => {
    expect(isEntryPoint(undefined)).toBe(false);
    expect(isEntryPoint(null)).toBe(false);
    expect(isEntryPoint(0)).toBe(false);
    expect(isEntryPoint(false)).toBe(false);
    expect(isEntryPoint({})).toBe(false);
    expect(isEntryPoint([])).toBe(false);
    expect(isEntryPoint(['create-new'])).toBe(false);
  });
});
