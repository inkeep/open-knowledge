import { describe, expect, test } from 'bun:test';
import { type GateableWebContents, registerPendingDelivery } from './ipc-send.ts';

function makeFakeWebContents() {
  const onceListeners = new Map<string, () => void>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  let destroyed = false;
  const wc: GateableWebContents = {
    once(event, listener) {
      onceListeners.set(event, listener);
    },
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    isDestroyed() {
      return destroyed;
    },
  };
  return {
    wc,
    sent,
    hasListener: (event: string) => onceListeners.has(event),
    fire: (event: 'dom-ready' | 'did-finish-load') => onceListeners.get(event)?.(),
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('registerPendingDelivery', () => {
  test('registers a dom-ready listener and does NOT send until the event fires', () => {
    const fake = makeFakeWebContents();
    registerPendingDelivery(fake.wc, 'ok:deep-link', {
      doc: 'a.md',
      branch: null,
      multiCandidate: false,
    });

    // Register-before-load invariant: nothing is delivered until the renderer
    // signals readiness, so a `send` can never beat the subscriber mount.
    expect(fake.hasListener('dom-ready')).toBe(true);
    expect(fake.sent).toHaveLength(0);

    fake.fire('dom-ready');
    expect(fake.sent).toEqual([
      { channel: 'ok:deep-link', payload: { doc: 'a.md', branch: null, multiCandidate: false } },
    ]);
  });

  test('respects the did-finish-load opt for subscribers that mount after first paint', () => {
    const fake = makeFakeWebContents();
    registerPendingDelivery(
      fake.wc,
      'ok:server-restarted',
      { appRuntime: '1.2.3' },
      { event: 'did-finish-load' },
    );

    expect(fake.hasListener('dom-ready')).toBe(false);
    expect(fake.hasListener('did-finish-load')).toBe(true);
    expect(fake.sent).toHaveLength(0);

    fake.fire('did-finish-load');
    expect(fake.sent).toEqual([
      { channel: 'ok:server-restarted', payload: { appRuntime: '1.2.3' } },
    ]);
  });

  test('skips delivery when the window is destroyed before the readiness event fires', () => {
    const fake = makeFakeWebContents();
    registerPendingDelivery(fake.wc, 'ok:deep-link', {
      doc: 'a.md',
      branch: null,
      multiCandidate: false,
    });

    // The register→readiness race: the user closes the window during the
    // loading spinner. `webContents.send` throws on a destroyed WebContents
    // and would crash main — the guard must skip the send entirely.
    fake.destroy();
    fake.fire('dom-ready');
    expect(fake.sent).toHaveLength(0);
  });
});
