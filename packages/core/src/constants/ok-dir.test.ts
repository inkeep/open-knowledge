import { posix } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OK_BIN_DIRNAME, OK_DIR, okUserHomeDisplayPath, posixOkManagedBinDir } from './ok-dir.ts';

describe('okUserHomeDisplayPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('names the Stable home folder by default', () => {
    vi.stubEnv('OK_CHANNEL', '');
    expect(okUserHomeDisplayPath()).toBe('~/.ok');
    expect(okUserHomeDisplayPath('global.yml')).toBe('~/.ok/global.yml');
    expect(okUserHomeDisplayPath('logs')).toBe('~/.ok/logs');
  });

  test('names the Beta home folder when the running channel is Beta', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(okUserHomeDisplayPath('global.yml')).toBe('~/.ok-beta/global.yml');
    expect(okUserHomeDisplayPath('secrets.yml')).toBe('~/.ok-beta/secrets.yml');
  });
});

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
