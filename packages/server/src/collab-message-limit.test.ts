import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { MessageType } from '@hocuspocus/server';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import * as encoding from 'lib0/encoding';
import { WebSocket as WsClient } from 'ws';
import { messageYjsUpdate } from 'y-protocols/sync';
import { type BootedServer, bootServer } from './boot.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

async function bootTestServer(): Promise<{ booted: BootedServer; contentDir: string }> {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-collab-limit-test-'));
  writeFileSync(join(contentDir, 'test-doc.md'), '# Test doc\n', 'utf-8');
  const okDir = join(contentDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(join(okDir, '.gitignore'), '', 'utf-8');
  const booted = await bootServer({
    host: '127.0.0.1',
    contentDir,
    attachUiSibling: false,
    idleShutdownMs: null,
    gitEnabled: false,
    quiet: true,
    debounce: 200,
    maxDebounce: 1000,
  });
  await booted.ready;
  return { booted, contentDir };
}

async function tearDown({
  booted,
  contentDir,
}: {
  booted: BootedServer;
  contentDir: string;
}): Promise<void> {
  await booted.destroy();
  rmSync(contentDir, { recursive: true, force: true });
}

const servers: Array<{ booted: BootedServer; contentDir: string }> = [];

afterAll(async () => {
  for (const s of servers) {
    try {
      await tearDown(s);
    } catch {
    }
  }
});

function makeOversizedSyncUpdate(docName: string, payloadBytes: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, docName);
  encoding.writeVarUint(enc, MessageType.Sync);
  encoding.writeVarUint(enc, messageYjsUpdate);
  encoding.writeVarUint8Array(enc, new Uint8Array(payloadBytes));
  return encoding.toUint8Array(enc);
}

function waitForClose(ws: WsClient, timeoutMs: number): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

describe('collab WebSocket message size limits', () => {
  test('frame of exactly MAX_COLLAB_MESSAGE_BYTES is accepted (strict > guard)', async () => {
    resetMetrics();
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;

    const MAX = 1024 * 1024;
    const payloadBytes = MAX - 14;
    const frame = makeOversizedSyncUpdate('test-doc', payloadBytes);
    expect(frame.byteLength).toBe(MAX); // validates the layout constant above

    const ws = new WsClient(`ws://127.0.0.1:${booted.port}/collab`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    try {
      let closedEarly = false;
      ws.once('close', () => {
        closedEarly = true;
      });
      ws.send(frame);
      await wait(300);

      expect(closedEarly).toBe(false);
      expect(getMetrics().collabMessageTooLargeCount).toBe(0);

      const response = await fetch(`http://127.0.0.1:${booted.port}/api/server-info`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.ok).toBe(true);
    } finally {
      if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
        ws.terminate();
      }
    }
  });

  test('oversized Yjs sync update is rejected before it can monopolize the server event loop', async () => {
    resetMetrics();
    const s = await bootTestServer();
    servers.push(s);
    const { booted } = s;

    const beforeRead = await fetch(
      `http://127.0.0.1:${booted.port}/api/document?docName=test-doc`,
      { signal: AbortSignal.timeout(1_000) },
    );
    expect(beforeRead.ok).toBe(true);
    expect((await beforeRead.json()).content).toBe('# Test doc\n');

    const ws = new WsClient(`ws://127.0.0.1:${booted.port}/collab`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    try {
      const closePromise = waitForClose(ws, 1_000);
      ws.send(makeOversizedSyncUpdate('test-doc', 2 * 1024 * 1024));
      const close = await closePromise;

      expect(close.code).toBe(1009);
      expect(getMetrics().collabMessageTooLargeCount).toBe(1);

      const response = await fetch(`http://127.0.0.1:${booted.port}/api/server-info`, {
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.ok).toBe(true);

      const afterRead = await fetch(
        `http://127.0.0.1:${booted.port}/api/document?docName=test-doc`,
        {
          signal: AbortSignal.timeout(1_000),
        },
      );
      expect(afterRead.ok).toBe(true);
      expect((await afterRead.json()).content).toBe('# Test doc\n');

      await wait(0);
    } finally {
      if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
        ws.terminate();
      }
    }
  });
});
