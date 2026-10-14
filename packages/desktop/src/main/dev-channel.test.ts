import { describe, expect, test } from 'vitest';
import { applyUnpackagedDevChannel, desktopProtocolScheme } from './dev-channel.ts';

describe('applyUnpackagedDevChannel', () => {
  test('an unpackaged build runs as the dev channel', () => {
    const env: Record<string, string | undefined> = {};
    applyUnpackagedDevChannel(env, false);
    expect(env.OK_CHANNEL).toBe('dev');
  });

  test.each(['stable', 'beta'])('an explicit OK_CHANNEL=%s still wins', (channel) => {
    const env: Record<string, string | undefined> = { OK_CHANNEL: channel };
    applyUnpackagedDevChannel(env, false);
    expect(env.OK_CHANNEL).toBe(channel);
  });

  test('a packaged app keeps resolving by its executable', () => {
    const env: Record<string, string | undefined> = {};
    applyUnpackagedDevChannel(env, true);
    expect(env.OK_CHANNEL).toBeUndefined();
  });

  test('the desktop smoke harness keeps the shipped identity', () => {
    const env: Record<string, string | undefined> = { OK_DESKTOP_E2E_SMOKE: '1' };
    applyUnpackagedDevChannel(env, false);
    expect(env.OK_CHANNEL).toBeUndefined();
  });
});

describe('desktopProtocolScheme', () => {
  test('a dev build claims openknowledge-dev, never Stable', () => {
    expect(desktopProtocolScheme(false, 'openknowledge', { OK_CHANNEL: 'dev' })).toBe(
      'openknowledge-dev',
    );
  });

  test('an unpackaged build pinned to a channel uses that channel', () => {
    expect(desktopProtocolScheme(false, 'openknowledge', { OK_CHANNEL: 'beta' })).toBe(
      'openknowledge-beta',
    );
  });

  test('a packaged build keeps its variant scheme whatever the env says', () => {
    expect(desktopProtocolScheme(true, 'openknowledge-beta', { OK_CHANNEL: 'dev' })).toBe(
      'openknowledge-beta',
    );
  });
});
