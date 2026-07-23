import { toast } from 'sonner';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { restartServerFailureMessage } from '@/lib/restart-collab-server';
import { runDisconnectRestart } from './use-sync-toasts';

// spyOn (not vi.doMock) so the sonner mock can't leak into sibling test
// files in the same `bun test` run.
const errorSpy = vi.spyOn(toast, 'error').mockImplementation((() => 'err-id') as never);

afterEach(() => {
  errorSpy.mockClear();
});

function makeBridge(outcome: Awaited<ReturnType<OkDesktopBridge['restartServer']>>): {
  bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>;
  restartServer: ReturnType<typeof vi.fn>;
} {
  const restartServer = vi.fn(async () => outcome);
  return {
    bridge: {
      restartServer,
      config: { projectPath: '/tmp/proj' },
    } as unknown as Pick<OkDesktopBridge, 'restartServer' | 'config'>,
    restartServer,
  };
}

describe('runDisconnectRestart', () => {
  test('calls restartServer with the projectPath; no error toast on success', async () => {
    const { bridge, restartServer } = makeBridge({ ok: true });
    await runDisconnectRestart(bridge);
    expect(restartServer).toHaveBeenCalledWith('/tmp/proj');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('surfaces an error toast with the mapped message on an eperm failure', async () => {
    const { bridge } = makeBridge({ ok: false, reason: 'eperm' });
    await runDisconnectRestart(bridge);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(restartServerFailureMessage('eperm'));
  });

  test('surfaces an error toast with the mapped message on an other failure', async () => {
    const { bridge } = makeBridge({ ok: false, reason: 'other' });
    await runDisconnectRestart(bridge);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(restartServerFailureMessage('other'));
  });

  test('swallows a thrown invoke (window torn down mid-restart) — no error toast', async () => {
    const restartServer = vi.fn(async () => {
      throw new Error('channel closed');
    });
    const bridge = {
      restartServer,
      config: { projectPath: '/tmp/proj' },
    } as unknown as Pick<OkDesktopBridge, 'restartServer' | 'config'>;
    await runDisconnectRestart(bridge);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
