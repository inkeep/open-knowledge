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
    const request: { url: string; dir: string; branch?: string | null } = {
      url: 'https://github.com/o/r.git',
      dir: '/tmp/r',
      branch: 'feat/foo',
    };

    const captured: CapturedStart[] = [];
    const ipc = ipcCloneTransport(makeBridge(captured, []));
    ipc.start(request);
    expect(captured[0]?.url).toBe(request.url);
    expect(captured[0]?.dir).toBe(request.dir);
    expect(captured[0]?.branch).toBe('feat/foo');

  });
});
