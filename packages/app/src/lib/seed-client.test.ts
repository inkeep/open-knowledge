import { describe, expect, test } from 'bun:test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { selectSeedTransport } from './seed-client';

function desktop(remote: boolean): Pick<OkDesktopBridge, 'config' | 'seed'> {
  return {
    config: {
      remote: remote
        ? {
            kind: 'ssh',
            machineId: 'machine-1',
            machineName: 'Build box',
            path: '/srv/knowledge',
            platform: 'linux',
            pathSeparator: '/',
          }
        : null,
    },
    seed: {},
  } as unknown as Pick<OkDesktopBridge, 'config' | 'seed'>;
}

describe('selectSeedTransport', () => {
  test('local desktop uses main-process IPC', () => {
    expect(selectSeedTransport(desktop(false))).toBe('desktop-ipc');
  });

  test('SSH desktop uses tunneled project HTTP', () => {
    expect(selectSeedTransport(desktop(true))).toBe('project-http');
  });

  test('web uses project HTTP', () => {
    expect(selectSeedTransport(undefined)).toBe('project-http');
  });
});
