import { describe, expect, test } from 'vitest';
import {
  applyChannelSettings,
  channelFromVersion,
  majorFromVersion,
} from '../../src/main/auto-updater.ts';

interface Bag {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

const blank = (): Bag => ({ channel: null, allowPrerelease: true, allowDowngrade: true });

describe('applyChannelSettings', () => {
  test('latest → channel=latest, allowPrerelease=false, allowDowngrade=false', () => {
    const u = blank();
    applyChannelSettings(u, 'latest');
    expect(u.channel).toBe('latest');
    expect(u.allowPrerelease).toBe(false);
    expect(u.allowDowngrade).toBe(false);
  });

  test('beta → channel=beta, allowPrerelease=true, allowDowngrade=false', () => {
    const u = blank();
    applyChannelSettings(u, 'beta');
    expect(u.channel).toBe('beta');
    expect(u.allowPrerelease).toBe(true);
    expect(u.allowDowngrade).toBe(false);
  });

  test('switch latest→beta→latest restores stable config (no auto-downgrade on either branch)', () => {
    const u = blank();
    applyChannelSettings(u, 'latest');
    applyChannelSettings(u, 'beta');
    applyChannelSettings(u, 'latest');
    expect(u.channel).toBe('latest');
    expect(u.allowPrerelease).toBe(false);
    expect(u.allowDowngrade).toBe(false);
  });
});

describe('channelFromVersion', () => {
  test('plain X.Y.Z → latest', () => {
    expect(channelFromVersion('0.4.0')).toBe('latest');
    expect(channelFromVersion('1.0.0')).toBe('latest');
    expect(channelFromVersion('12.34.56')).toBe('latest');
  });

  test('prerelease tag → beta (PRD-6633: feed mirrors the binary)', () => {
    expect(channelFromVersion('0.4.0-beta.36')).toBe('beta');
    expect(channelFromVersion('0.4.0-beta.1')).toBe('beta');
    expect(channelFromVersion('1.2.3-rc.0')).toBe('beta');
    expect(channelFromVersion('1.2.3-alpha')).toBe('beta');
  });

  test('build metadata is ignored', () => {
    expect(channelFromVersion('0.4.0+sha.abc')).toBe('latest');
    expect(channelFromVersion('0.4.0-beta.1+sha.abc')).toBe('beta');
  });

  test('unparseable / empty version falls back to latest (conservative default)', () => {
    expect(channelFromVersion('')).toBe('latest');
    expect(channelFromVersion('not-a-version')).toBe('latest');
    expect(channelFromVersion('0.4')).toBe('latest');
    expect(channelFromVersion(undefined as unknown as string)).toBe('latest');
  });
});

describe('majorFromVersion', () => {
  test('extracts the numeric major version from stable, prerelease, and build-metadata semver', () => {
    expect(majorFromVersion('0.89.18')).toBe(0);
    expect(majorFromVersion('0.89.18-beta.0')).toBe(0);
    expect(majorFromVersion('1.0.0')).toBe(1);
    expect(majorFromVersion('1.0.0-beta.0')).toBe(1);
    expect(majorFromVersion('12.34.56+sha.abc')).toBe(12);
  });

  test('returns null for empty or unparseable versions', () => {
    expect(majorFromVersion('')).toBeNull();
    expect(majorFromVersion('not-a-version')).toBeNull();
    expect(majorFromVersion('0.89')).toBeNull();
    expect(majorFromVersion(undefined as unknown as string)).toBeNull();
  });
});
