// @vitest-environment jsdom
import type { OkUninstallBridge, UninstallDispatchResult } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { requestUninstallScreen, sendUninstallIntent } from './bridge';

function bridgeWith(ready: () => Promise<UninstallDispatchResult>): OkUninstallBridge {
  return {
    ready,
    send: (): Promise<UninstallDispatchResult> => Promise.resolve({ kind: 'accepted' }),
  };
}

describe('requestUninstallScreen', () => {
  afterEach(() => {
    window.okUninstall = undefined;
  });

  test('returns null when the window has no bridge', async () => {
    window.okUninstall = undefined;
    expect(await requestUninstallScreen()).toBeNull();
  });

  test('returns the screen main answers the ready pull with', async () => {
    window.okUninstall = bridgeWith(() =>
      Promise.resolve({ kind: 'screen', screen: { kind: 'progress' } }),
    );
    expect(await requestUninstallScreen()).toEqual({ kind: 'progress' });
  });

  test('returns null when main refuses', async () => {
    window.okUninstall = bridgeWith(() =>
      Promise.resolve({ kind: 'refused', reason: 'unknown-window' }),
    );
    expect(await requestUninstallScreen()).toBeNull();
  });

  test('resolves to null instead of rejecting when the ready invoke rejects', async () => {
    window.okUninstall = bridgeWith(() => Promise.reject(new Error('ipc channel closed')));
    await expect(requestUninstallScreen()).resolves.toBeNull();
  });
});

describe('sendUninstallIntent', () => {
  afterEach(() => {
    window.okUninstall = undefined;
  });

  test('is a no-op when the window has no bridge', () => {
    window.okUninstall = undefined;
    expect(() => sendUninstallIntent({ kind: 'picker-cancel' })).not.toThrow();
  });

  test('swallows a rejected send so a teardown race is not an unhandled rejection', async () => {
    let sent: unknown;
    window.okUninstall = {
      ready: () => Promise.resolve({ kind: 'refused', reason: 'unknown-window' }),
      send: (intent): Promise<UninstallDispatchResult> => {
        sent = intent;
        return Promise.reject(new Error('channel torn down'));
      },
    };
    expect(() => sendUninstallIntent({ kind: 'notice-confirm' })).not.toThrow();
    expect(sent).toEqual({ kind: 'notice-confirm' });
    await Promise.resolve();
  });
});
