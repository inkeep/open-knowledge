import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

const HUMAN_PENDING_LINE = 'Zzz human paragraph typed before the realign.';
const CHECKPOINT_WRITE_EVENT = 'checkpoint-write';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RING_POLL_ATTEMPTS = 40;
const RING_POLL_INTERVAL_MS = 50;
const RING_WAIT_BUDGET_MS = RING_POLL_ATTEMPTS * RING_POLL_INTERVAL_MS;

function ringPath(contentDir: string): string {
  return join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl');
}

function readLossEvents(contentDir: string): Array<{ event: string; docName: string }> {
  try {
    return readFileSync(ringPath(contentDir), 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { event: string; docName: string }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

async function agentWrite(
  port: number,
  markdown: string,
  opts: { docName: string; position: 'append' | 'replace' },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, ...opts }),
  });
}

async function stageDivergenceRealign(server: TestServer, docName: string): Promise<void> {
  const { port, contentDir } = server;
  const docPath = join(contentDir, `${docName}.md`);

  expect(
    (await agentWrite(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' })).status,
  ).toBe(200);
  await pollUntil(() => existsSync(docPath) && readFileSync(docPath, 'utf-8').includes('body-v1'));

  const client = await createTestClient(port, docName);
  try {
    await pollUntil(() => client.ytext.toString().includes('body-v1'));
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.toString().length, `\n${HUMAN_PENDING_LINE}\n`);
    });
    await pollUntil(() =>
      Boolean(
        server.instance.hocuspocus.documents
          .get(docName)
          ?.getText('source')
          .toString()
          .includes(HUMAN_PENDING_LINE),
      ),
    );

    process.env.OK_TEST_STORE_DIVERGENCE = docName;
    const attempt = await agentWrite(port, 'AGENT-APPEND-XYZ\n', { docName, position: 'append' });
    expect(attempt.status).toBe(409);

    await pollUntil(
      () =>
        !server.instance.hocuspocus.documents
          .get(docName)
          ?.getText('source')
          .toString()
          .includes(HUMAN_PENDING_LINE),
    );
  } finally {
    await client.cleanup();
  }
}

describe('loss-capture ring — kill-switch behavioral pair', () => {
  const owned: Array<{ server: TestServer; contentDir?: string }> = [];

  afterEach(async () => {
    delete process.env.OK_TEST_STORE_DIVERGENCE;
    for (const { server, contentDir } of owned.splice(0)) {
      await server.cleanup();
      if (contentDir) rmSync(contentDir, { recursive: true, force: true });
    }
  });

  test(
    'ON (default): a discarded edit lands a content-free checkpoint-write event in the ring',
    async () => {
      const server = await createTestServer({
        gitEnabled: true,
        debounce: 300_000,
        maxDebounce: 600_000,
      });
      owned.push({ server });
      const docName = `ring-on-${crypto.randomUUID().slice(0, 8)}`;
      await stageDivergenceRealign(server, docName);

      await pollUntil(() =>
        readLossEvents(server.contentDir).some(
          (e) => e.event === CHECKPOINT_WRITE_EVENT && e.docName === docName,
        ),
      );
      const written = readLossEvents(server.contentDir).filter(
        (e) => e.event === CHECKPOINT_WRITE_EVENT && e.docName === docName,
      );
      expect(written.length).toBeGreaterThan(0);
      expect(JSON.stringify(written)).not.toContain(HUMAN_PENDING_LINE);
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );

  test(
    'OFF (lossCapture.enabled: false): the same discard records nothing',
    async () => {
      const contentDir = mkdtempSync(join(tmpdir(), 'ok-ring-off-'));
      mkdirSync(join(contentDir, '.ok'), { recursive: true });
      writeFileSync(
        join(contentDir, '.ok', 'config.yml'),
        'lossCapture:\n  enabled: false\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');

      const server = await createTestServer({
        contentDir,
        keepContentDir: true,
        gitEnabled: true,
        debounce: 300_000,
        maxDebounce: 600_000,
      });
      owned.push({ server, contentDir: server.contentDir });
      const docName = `ring-off-${crypto.randomUUID().slice(0, 8)}`;
      await stageDivergenceRealign(server, docName);

      expect(existsSync(ringPath(server.contentDir))).toBe(false);
      await sleep(RING_WAIT_BUDGET_MS);
      expect(existsSync(ringPath(server.contentDir))).toBe(false);
      expect(readLossEvents(server.contentDir)).toEqual([]);
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );
});
