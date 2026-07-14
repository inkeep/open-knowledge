import { describe, expect, mock, test } from 'bun:test';
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

  test('SSH projects point at remote connection and prerequisite recovery', () => {
    expect(restartServerFailureMessage('other', true)).toBe(
      "Couldn't reconnect to the SSH project. Check the SSH connection and the remote OpenKnowledge prerequisites, then try again.",
    );
  });
});

describe('restartCollabServer', () => {
  function makeBridge(
    outcome: Awaited<ReturnType<OkDesktopBridge['restartServer']>>,
    remote = false,
  ): {
    bridge: Pick<OkDesktopBridge, 'restartServer' | 'config'>;
    restartServer: ReturnType<typeof mock>;
  } {
    const restartServer = mock(async () => outcome);
    return {
      bridge: {
        restartServer,
        config: {
          projectPath: remote ? 'ssh:machine-1:%2Fsrv%2Fwiki' : '/tmp/proj',
          ...(remote
            ? {
                remote: {
                  kind: 'ssh' as const,
                  machineId: 'machine-1',
                  machineName: 'Build box',
                  path: '/srv/wiki',
                  platform: 'linux',
                  pathSeparator: '/' as const,
                },
              }
            : {}),
        },
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

  test('maps a remote failure to SSH recovery guidance', async () => {
    const { bridge, restartServer } = makeBridge({ ok: false, reason: 'other' }, true);
    const result = await restartCollabServer(bridge);
    expect(restartServer).toHaveBeenCalledWith('ssh:machine-1:%2Fsrv%2Fwiki');
    expect(result).toEqual({
      ok: false,
      message: restartServerFailureMessage('other', true),
    });
  });
});
