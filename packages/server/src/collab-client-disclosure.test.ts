import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

/**
 * `GET /api/server-info` discloses the live `/collab` client count so a caller
 * about to terminate this process can ask whether anything is using it. The
 * count is the only answerable form of that question — the process title is
 * rewritten at start, so provenance is not recoverable from the OS.
 */
let tmpRoot: string;
let booted: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-collab-count-'));
  booted = await bootCompositionRig(tmpRoot);
  await booted.ready;
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function readCollabClients(): Promise<number | undefined> {
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/server-info`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { collabClients?: number };
  return body.collabClients;
}

describe('server-info collabClients', () => {
  test('reports zero with no clients attached', async () => {
    expect(await readCollabClients()).toBe(0);
  });

  test('counts a live collaboration client and releases it on close', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/collab/count-probe`);
    await new Promise<void>((resolvePromise, reject) => {
      ws.on('open', () => resolvePromise());
      ws.on('error', reject);
    });

    expect(await readCollabClients()).toBe(1);

    ws.close();
    await new Promise<void>((resolvePromise) => ws.on('close', () => resolvePromise()));
    // The count drops on the server's socket 'close', which can land after the
    // client-side close event.
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readCollabClients()) === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await readCollabClients()).toBe(0);
  });
});
