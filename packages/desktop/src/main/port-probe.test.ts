import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { probeLoopbackPort } from './port-probe.ts';

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

describe('probeLoopbackPort', () => {
  let held: Server | undefined;
  afterEach(async () => {
    if (held) await new Promise<void>((r) => held?.close(() => r()));
    held = undefined;
  });

  test('rejects out-of-range and non-integer ports without binding', async () => {
    expect(await probeLoopbackPort(0)).toBe(false);
    expect(await probeLoopbackPort(70000)).toBe(false);
    expect(await probeLoopbackPort(24_550.5)).toBe(false);
  });

  test('true for a free port, false while it is held', async () => {
    // Grab a kernel-assigned free port, learn its number, release it.
    const scout = await listenOn(0);
    const port = (scout.address() as { port: number }).port;
    await new Promise<void>((r) => scout.close(() => r()));

    expect(await probeLoopbackPort(port)).toBe(true);

    held = await listenOn(port);
    expect(await probeLoopbackPort(port)).toBe(false);
  });

  test('a free probe leaves the port free for a real bind afterward', async () => {
    const scout = await listenOn(0);
    const port = (scout.address() as { port: number }).port;
    await new Promise<void>((r) => scout.close(() => r()));

    expect(await probeLoopbackPort(port)).toBe(true);
    // The probe must have closed its own handle, so a real bind still succeeds.
    held = await listenOn(port);
    expect((held.address() as { port: number }).port).toBe(port);
  });
});
