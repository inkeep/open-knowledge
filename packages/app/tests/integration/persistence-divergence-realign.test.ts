import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

const INJECTED_MARKER = 'native-divergence-injected';

const HUMAN_PENDING_LINE = 'Zzz human paragraph typed before the realign.';

const AGENT_LINE = 'AGENT-APPEND-XYZ';

interface LossRingEvent {
  event: string;
  docName: string;
  site?: string;
  direction?: string;
  writerId?: string | null;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
}

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_DIVERGENCE;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

function readLossEvents(contentDir: string): LossRingEvent[] {
  const path = join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LossRingEvent];
      } catch {
        return [];
      }
    });
}

function shadowDirFor(s: TestServer): string {
  const dir = join(s.contentDir, '.git', 'ok');
  if (!existsSync(dir)) {
    throw new Error(`shadow repo not found at ${dir}; the rig needs gitEnabled: true`);
  }
  return dir;
}

function shadowGitRaw(s: TestServer, args: string[]): string {
  return execFileSync('git', ['--git-dir', shadowDirFor(s), ...args], {
    encoding: 'utf-8',
  }).toString();
}

function listCheckpoints(s: TestServer): Array<{ sha: string; kind: string | null }> {
  const shas = shadowGitRaw(s, ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints'])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return shas.map((sha) => ({
    sha,
    kind: parseCheckpoint(shadowGitRaw(s, ['log', '-1', '--format=%B', sha]))?.kind ?? null,
  }));
}

async function agentWriteMd(
  port: number,
  markdown: string,
  opts: { docName: string; position: 'append' | 'prepend' | 'replace' },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, ...opts }),
  });
}

async function pollUntil(
  predicate: () => boolean,
  { timeoutMs = 10_000, pollMs = 50 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

describe('L3 agent-write divergence realign — content-loss conventions', () => {
  test(
    'the realign checkpoints the live document and reports the loss before discarding it',
    async () => {
      server = await createTestServer({
        gitEnabled: true,
        debounce: 300_000,
        maxDebounce: 600_000,
      });
      const { port, contentDir } = server;
      const docName = `realign-${randomUUID().slice(0, 8)}`;
      const docPath = join(contentDir, `${docName}.md`);

      const seed = await agentWriteMd(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' });
      expect(seed.status).toBe(200);
      await pollUntil(
        () => existsSync(docPath) && readFileSync(docPath, 'utf-8').includes('body-v1'),
      );

      const client = await createTestClient(port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString().includes('body-v1'));
      const before = client.ytext.toString();
      client.doc.transact(() => {
        client.ytext.insert(before.length, `\n${HUMAN_PENDING_LINE}\n`);
      });
      await pollUntil(() =>
        Boolean(
          server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(HUMAN_PENDING_LINE),
        ),
      );
      expect(readFileSync(docPath, 'utf-8')).not.toContain(HUMAN_PENDING_LINE);

      process.env.OK_TEST_STORE_DIVERGENCE = docName;

      const attempt = await agentWriteMd(port, `${AGENT_LINE}\n`, { docName, position: 'append' });
      expect(attempt.status).toBe(409);
      expect(((await attempt.json()) as { type?: string }).type).toBe(
        'urn:ok:error:disk-divergence',
      );

      await pollUntil(() => readFileSync(docPath, 'utf-8').includes(INJECTED_MARKER));
      expect(readFileSync(docPath, 'utf-8')).not.toContain(AGENT_LINE);

      await pollUntil(
        () =>
          !server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(HUMAN_PENDING_LINE),
      );

      const rig = server;
      await pollUntil(() =>
        listCheckpoints(rig).some((c) => c.kind === 'persistence-divergence-realign'),
      );
      const anchors = listCheckpoints(rig).filter(
        (c) => c.kind === 'persistence-divergence-realign',
      );
      expect(anchors).toHaveLength(1);
      const anchor = anchors[0];
      if (!anchor) throw new Error('unreachable: anchor asserted above');

      const blob = shadowGitRaw(rig, ['show', `${anchor.sha}:${docName}`]);
      expect(blob).toContain(HUMAN_PENDING_LINE);

      const ring = readLossEvents(contentDir).filter(
        (e) => e.site === 'persistence-divergence-realign' && e.docName === docName,
      );
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.direction).toBe('b');
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThanOrEqual(HUMAN_PENDING_LINE.length);
      expect(JSON.stringify(trips[0])).not.toContain(HUMAN_PENDING_LINE);
      await pollUntil(() =>
        readLossEvents(contentDir).some(
          (e) =>
            e.site === 'persistence-divergence-realign' &&
            e.event === 'checkpoint-write' &&
            e.checkpointSha === anchor.sha,
        ),
      );

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );
});
