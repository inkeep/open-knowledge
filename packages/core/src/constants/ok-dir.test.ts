import { posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import { OK_BIN_DIRNAME, OK_DIR, posixOkManagedBinDir } from './ok-dir.ts';

describe('posixOkManagedBinDir', () => {
  test('is the OK dir plus the bin dirname, under the given home', () => {
    expect(posixOkManagedBinDir('/Users/alice')).toBe(`/Users/alice/${OK_DIR}/${OK_BIN_DIRNAME}`);
    expect(posixOkManagedBinDir('/Users/alice')).toBe('/Users/alice/.ok/bin');
  });

  test('normalizes trailing separators on the home it is given', () => {
    expect(posixOkManagedBinDir('/Users/alice/')).toBe('/Users/alice/.ok/bin');
    expect(posixOkManagedBinDir('/Users/alice///')).toBe('/Users/alice/.ok/bin');
  });

  test('collapses repeated interior separators the way posix.join would', () => {
    expect(posixOkManagedBinDir('/Users//alice')).toBe('/Users/alice/.ok/bin');
    expect(posixOkManagedBinDir('//Users/alice')).toBe('/Users/alice/.ok/bin');
  });

  test('leaves a backslash alone, since it is a legal character in a POSIX home', () => {
    expect(posixOkManagedBinDir('/home/a\\b')).toBe('/home/a\\b/.ok/bin');
  });

  test('leaves a root home resolvable', () => {
    expect(posixOkManagedBinDir('/')).toBe('/.ok/bin');
  });

  test('stays byte-identical to the posix join both call sites used before they shared it', () => {
    for (const home of ['/Users/alice', '/Users/alice/', '/home/a\\b', '/']) {
      expect(posixOkManagedBinDir(home)).toBe(posix.join(home, OK_DIR, OK_BIN_DIRNAME));
    }
  });
});
