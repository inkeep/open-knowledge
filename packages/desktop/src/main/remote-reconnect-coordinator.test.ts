import { describe, expect, mock, test } from 'bun:test';
import { RemoteReconnectCoordinator } from './remote-reconnect-coordinator.ts';

describe('RemoteReconnectCoordinator', () => {
  test('coalesces concurrent reconnects for the same remote project', async () => {
    const coordinator = new RemoteReconnectCoordinator();
    let resolve!: (value: { ok: true }) => void;
    const reconnect = mock(
      () =>
        new Promise<{ ok: true }>((done) => {
          resolve = done;
        }),
    );

    const first = coordinator.run('ssh:machine:%2Fsrv%2Fwiki', reconnect);
    const second = coordinator.run('ssh:machine:%2Fsrv%2Fwiki', reconnect);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  test('clears a failed transaction so a later reconnect can retry', async () => {
    const coordinator = new RemoteReconnectCoordinator();
    await expect(
      coordinator.run('ssh:machine:%2Fsrv%2Fwiki', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    await Promise.resolve();

    await expect(
      coordinator.run('ssh:machine:%2Fsrv%2Fwiki', async () => ({ ok: true })),
    ).resolves.toEqual({ ok: true });
  });
});
