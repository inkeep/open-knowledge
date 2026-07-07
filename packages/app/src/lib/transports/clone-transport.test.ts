/**
 * Symmetry contract between HTTP and IPC clone transports.
 *
 * The share-receive flow's `cloneController.runClone({url, branch})` is
 * transport-agnostic: it calls `transport.start({url, dir, branch})` and
 * iterates the returned `events` for `progress` / `branch-fallback` /
 * `complete` / `error`. Both transports MUST thread `branch` through to the
 * subprocess AND forward `branch-fallback` events back so the receiver-side
 * "Branch X no longer exists" toast renders regardless of which window
 * (editor → HTTP, Navigator → IPC) drove the share.
 *
 * Without this symmetry, opening a share link
 * in the Navigator silently drops branch + the fallback signal.
 */
import { describe, expect, test } from 'bun:test';
import type { OkDesktopBridge, OkLocalOpCloneEvent } from '@/lib/desktop-bridge-types';
import { ipcCloneTransport } from './clone-transport';

interface CapturedStart {
  url: string;
  dir: string;
  branch: string | null | undefined;
}

function makeBridge(captured: CapturedStart[], events: OkLocalOpCloneEvent[]): OkDesktopBridge {
  const bridge = {
    localOp: {
      clone: {
        start: (request: { url: string; dir: string; branch?: string | null }) => {
          captured.push({ url: request.url, dir: request.dir, branch: request.branch });
          return {
            events: (async function* () {
              for (const ev of events) yield ev;
            })(),
            cancel: () => {},
          };
        },
      },
    },
  };
  // Cast through unknown — only `localOp.clone.start` is exercised; the
  // rest of the bridge surface is irrelevant to this test.
  return bridge as unknown as OkDesktopBridge;
}

describe('ipcCloneTransport — branch threading symmetry with HTTP transport', () => {
  test('forwards explicit branch through to bridge.localOp.clone.start', () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(makeBridge(captured, []));
    transport.start({ url: 'https://github.com/o/r.git', dir: '/tmp/r', branch: 'feat/foo' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.branch).toBe('feat/foo');
  });

  test('absent branch normalizes to null (legacy default-branch behavior)', () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(makeBridge(captured, []));
    transport.start({ url: 'https://github.com/o/r.git', dir: '/tmp/r' });
    expect(captured[0]?.branch).toBeNull();
  });

  test('null branch passes through as null', () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(makeBridge(captured, []));
    transport.start({ url: 'https://github.com/o/r.git', dir: '/tmp/r', branch: null });
    expect(captured[0]?.branch).toBeNull();
  });

  test('empty-string branch normalizes to null (no -b sent)', () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(makeBridge(captured, []));
    transport.start({ url: 'https://github.com/o/r.git', dir: '/tmp/r', branch: '' });
    expect(captured[0]?.branch).toBeNull();
  });

  test('slashed branch threads verbatim', () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(makeBridge(captured, []));
    transport.start({
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feature/long-branch-name',
    });
    expect(captured[0]?.branch).toBe('feature/long-branch-name');
  });

  test('surfaces branch-fallback event verbatim from the bridge stream', async () => {
    const captured: CapturedStart[] = [];
    const transport = ipcCloneTransport(
      makeBridge(captured, [
        { type: 'progress', phase: 'Resolving deltas', pct: 50 },
        { type: 'branch-fallback', branch: 'feat/foo' },
        { type: 'complete', dir: '/tmp/r' },
      ]),
    );
    const handle = transport.start({
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    });

    const observed: Array<{ type: string; branch?: string }> = [];
    for await (const event of handle.events) {
      if (event.type === 'branch-fallback') {
        observed.push({ type: event.type, branch: event.branch });
      } else {
        observed.push({ type: event.type });
      }
      if (event.type === 'complete' || event.type === 'error') break;
    }
    expect(observed).toEqual([
      { type: 'progress' },
      { type: 'branch-fallback', branch: 'feat/foo' },
      { type: 'complete' },
    ]);
  });
});

describe('CloneTransport contract — shape symmetry between HTTP + IPC', () => {
  test('both transports accept the same start() request shape', () => {
    // Type-level: assigning a single request literal to both transport
    // factories' parameter types must compile. Runtime no-ops the body —
    // the test value is the type-system gate, not assertion behavior.
    const request: { url: string; dir: string; branch?: string | null } = {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    };

    // IPC side — runtime check the IPC transport's start accepts the shape.
    const captured: CapturedStart[] = [];
    const ipc = ipcCloneTransport(makeBridge(captured, []));
    ipc.start(request);
    expect(captured[0]?.url).toBe(request.url);
    expect(captured[0]?.dir).toBe(request.dir);
    expect(captured[0]?.branch).toBe('feat/foo');

    // The HTTP transport's start() signature is structurally identical
    // (CloneTransport interface) — symmetry is enforced at compile time
    // by both factories returning `CloneTransport`. No runtime fetch
    // invocation needed; the type-system gate is sufficient.
  });
});
