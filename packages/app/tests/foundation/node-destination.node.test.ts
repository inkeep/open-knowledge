import { describe, expect, test } from 'vitest';
import { installedDomGlobals } from './node-dom-globals';

const definedAtModuleLoad = installedDomGlobals();

describe('the Node destination', () => {
  test('window, document and Storage are undefined while a test runs', () => {
    expect([typeof window, typeof document, typeof Storage]).toEqual([
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  test('no DOM global is defined when the test module loads or while its test runs', () => {
    expect(definedAtModuleLoad).toEqual([]);
    expect(installedDomGlobals()).toEqual([]);
  });

  test('the DOM check names every DOM global a scope defines', () => {
    expect(
      installedDomGlobals({ window: {}, document: {}, localStorage: {}, navigator: {} }),
    ).toEqual(['window', 'document', 'localStorage']);
  });
});
