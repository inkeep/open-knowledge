import { describe, expect, test } from 'bun:test';
import { isFileProtocolPage } from './file-protocol-page';

describe('isFileProtocolPage', () => {
  test('true for a file: page (packaged Electron renderer)', () => {
    expect(isFileProtocolPage({ protocol: 'file:' })).toBe(true);
  });

  test('false for http: (web, ok ui, dev desktop renderer on localhost)', () => {
    expect(isFileProtocolPage({ protocol: 'http:' })).toBe(false);
  });

  test('false for https:', () => {
    expect(isFileProtocolPage({ protocol: 'https:' })).toBe(false);
  });

  test('false when no window/location exists (unit tier has no DOM)', () => {
    // Default parameter path: the unit-tier substrate runs without a DOM
    // `window`, so the default resolves to undefined.
    expect(isFileProtocolPage()).toBe(false);
  });
});
