import { describe, expect, test, vi } from 'vitest';
import type { IpcInvoker } from '../shared/ipc-invoke.ts';
import { createSlidesBridge } from './slides-bridge.ts';

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
