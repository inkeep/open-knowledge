import { describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { restartCollabServer, restartServerFailureMessage } from './restart-collab-server';

describe('restartServerFailureMessage', () => {
  test('eperm names the ownership conflict', () => {
    expect(restartServerFailureMessage('eperm')).toBe(
      "Couldn't restart the server — another process owns it. Quit other OpenKnowledge windows for this project, then try again.",
    );
  });

  test('other points at the ok start fallback', () => {
    expect(restartServerFailureMessage('other')).toBe(
      "Couldn't restart the server. Try `ok start` in this folder.",
    );
  });
});

describe('restartCollabServer', () => {
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

  test('calls restartServer with the bridge projectPath and reports success', async () => {
    const { bridge, restartServer } = makeBridge({ ok: true });
    const result = await restartCollabServer(bridge);
    expect(restartServer).toHaveBeenCalledWith('/tmp/proj');
    expect(result).toEqual({ ok: true });
  });

  test('maps an eperm failure to the ownership message', async () => {
    const { bridge } = makeBridge({ ok: false, reason: 'eperm' });
    const result = await restartCollabServer(bridge);
    expect(result).toEqual({ ok: false, message: restartServerFailureMessage('eperm') });
  });

  test('maps an other failure to the ok start fallback message', async () => {
    const { bridge } = makeBridge({ ok: false, reason: 'other' });
    const result = await restartCollabServer(bridge);
    expect(result).toEqual({ ok: false, message: restartServerFailureMessage('other') });
  });
});
