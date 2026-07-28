// @vitest-environment jsdom
// jsdom (not the default node env) so `window.okUninstall` exists to stub — the
// bridge reads it. This tests the bridge FUNCTIONS, not a React mount, so it is
// deliberately not a `.dom.test.tsx` (that suffix is the Tier-3 RTL-mount
// contract; see tests/integration/dom-test-filename-stop-rule.test.ts).
import type { OkUninstallBridge, UninstallDispatchResult } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { requestUninstallScreen, sendUninstallIntent } from './bridge';

/**
 * The bridge is the renderer's only channel to main, and the window has no way
 * to recover from a dead one — so `requestUninstallScreen` owes its caller a
 * plain `null` on every failure mode (no bridge, a `refused`, or a rejected
 * invoke) rather than a rejected promise the caller's catch-less `.then` would
 * drop, hanging the window on its loading placeholder.
 */
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
        // Settling a screen destroys the window, tearing the channel down under
        // this in-flight invoke — the intent is fire-and-forget by contract.
        return Promise.reject(new Error('channel torn down'));
      },
    };
    expect(() => sendUninstallIntent({ kind: 'notice-confirm' })).not.toThrow();
    expect(sent).toEqual({ kind: 'notice-confirm' });
    // Let the swallowing `.catch` run; the test fails on an unhandled rejection.
    await Promise.resolve();
  });
});
