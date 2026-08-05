/**
 * The slides bridge slice, driven over a fake invoker.
 *
 * The seam is carved at the IPC call — the true external boundary — so the
 * narrowing and the wrong-arm guards below are the SAME code the preload runs
 * in production. The renderer-side DOM tests fake `window.okDesktop.slides`
 * wholesale, which sits ABOVE this logic and therefore replaces it rather than
 * exercising it; before this file the two `expected … result` throws existed
 * only in source, with nothing running them.
 *
 * What a fake invoker cannot prove is left to the Electron tier: that
 * `contextBridge` actually exposes this slice on `window.okDesktop`, and that
 * main's handler answers the channel at all.
 */

import { describe, expect, test, vi } from 'vitest';
import type { IpcInvoker } from '../shared/ipc-invoke.ts';
import { createSlidesBridge } from './slides-bridge.ts';

/** A fake invoker that answers `ok:slides:dispatch` with whatever the test
 *  scripts. Typed loosely at the seam only — the production narrowing above it
 *  is what these tests are here to run. */
function fakeInvoker(reply: (req: { kind: string; docPath?: string }) => unknown): IpcInvoker {
  return vi.fn((_channel: string, req: unknown) =>
    Promise.resolve(reply(req as { kind: string; docPath?: string })),
  ) as unknown as IpcInvoker;
}

describe('createSlidesBridge — happy path', () => {
  test('status passes the status arm through', async () => {
    const bridge = createSlidesBridge(
      fakeInvoker(() => ({ kind: 'status', available: true, source: 'global' })),
    );
    await expect(bridge.status()).resolves.toEqual({
      kind: 'status',
      available: true,
      source: 'global',
    });
  });

  test('open sends the doc path and passes the open arm through', async () => {
    const invoke = fakeInvoker(() => ({ kind: 'open', ok: true }));
    const bridge = createSlidesBridge(invoke);

    await expect(bridge.open('/proj/decks/talk.md')).resolves.toEqual({ kind: 'open', ok: true });
    expect(invoke).toHaveBeenCalledWith('ok:slides:dispatch', {
      kind: 'open',
      docPath: '/proj/decks/talk.md',
    });
  });

  test('a failure arm is a value, not a throw — the renderer renders the reason', async () => {
    const bridge = createSlidesBridge(
      fakeInvoker(() => ({ kind: 'open', ok: false, reason: 'timeout' })),
    );
    await expect(bridge.open('/proj/deck.md')).resolves.toEqual({
      kind: 'open',
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('createSlidesBridge — wrong-arm guards', () => {
  // These are the guards that had no coverage at all. A main-process handler
  // regression that answered the wrong arm would otherwise reach the renderer
  // as a plausible object of the wrong shape, and fail somewhere further away.
  test('status throws when main answers with the open arm', async () => {
    const bridge = createSlidesBridge(fakeInvoker(() => ({ kind: 'open', ok: true })));
    await expect(bridge.status()).rejects.toThrow('expected status result');
  });

  test('open throws when main answers with the status arm', async () => {
    const bridge = createSlidesBridge(fakeInvoker(() => ({ kind: 'status', available: false })));
    await expect(bridge.open('/proj/deck.md')).rejects.toThrow('expected open result');
  });

  test('a malformed reply with no arm at all is refused, not passed through', async () => {
    const bridge = createSlidesBridge(fakeInvoker(() => ({})));
    await expect(bridge.status()).rejects.toThrow('expected status result');
    await expect(bridge.open('/proj/deck.md')).rejects.toThrow('expected open result');
  });
});
