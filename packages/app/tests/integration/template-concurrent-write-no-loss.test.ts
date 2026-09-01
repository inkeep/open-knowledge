import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

const AUTHOR_PENDING_LINE = 'Zzz author sentence pending when the reconcile fired.';

const FOREIGN_LINE = 'Foreign edit from a second OK window.';

interface LossRingEvent {
  event: string;
  docName: string;
  site?: string;
  direction?: string;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
}

let server: TestServer | undefined;

afterEach(async () => {
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

function shadowGitRaw(s: TestServer, args: string[]): string {
  const dir = join(s.contentDir, '.git', 'ok');
  if (!existsSync(dir)) {
    throw new Error(`shadow repo not found at ${dir}; the rig needs gitEnabled: true`);
  }
  return execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf-8' }).toString();
}

function listCheckpoints(s: TestServer): Array<{ sha: string; kind: string | null }> {
  return shadowGitRaw(s, ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints'])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((sha) => ({
      sha,
      kind: parseCheckpoint(shadowGitRaw(s, ['log', '-1', '--format=%B', sha]))?.kind ?? null,
    }));
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

async function storeImmediately(rig: TestServer, docName: string): Promise<void> {
  const document = rig.instance.hocuspocus.documents.get(docName);
  if (!document) throw new Error(`document not loaded: ${docName}`);

  await rig.instance.hocuspocus.hooks('onStoreDocument', {
    clientsCount: document.getConnectionsCount(),
    document,
    lastContext: {},
    lastTransactionOrigin: undefined,
    documentName: docName,
    instance: rig.instance.hocuspocus,
  });
}

describe('template concurrent-write reconcile on the content branch', () => {
  test(
    'a concurrent external write reconciles without discarding the author live edit',
    async () => {
      server = await createTestServer({ gitEnabled: true, debounce: 150, maxDebounce: 600 });
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;
      const tplFile = resolve(server.contentDir, '.ok', 'templates', `${name}.md`);

      const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

      const v1 = `---\ntitle: T\ndescription: d\n---\n\n# Template\n\nv1 body.\n`;
      client.doc.transact(() => client.ytext.insert(0, v1));
      await pollUntil(() => existsSync(tplFile) && readFileSync(tplFile, 'utf-8') === v1);

      const live = client.ytext.toString();
      client.doc.transact(() => client.ytext.insert(live.length, `\n${AUTHOR_PENDING_LINE}\n`));
      await pollUntil(() =>
        Boolean(
          server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(AUTHOR_PENDING_LINE),
        ),
      );

      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      const foreign = `---\ntitle: T\ndescription: d\n---\n\n# Template\n\n${FOREIGN_LINE}\n`;
      writeFileSync(tplFile, foreign, 'utf-8');
      await storeImmediately(server, docName);

      const rig = server;
      const docSource = rig.instance.hocuspocus.documents
        .get(docName)
        ?.getText('source')
        .toString();
      expect(docSource).toContain(AUTHOR_PENDING_LINE);
      expect(docSource).not.toContain(FOREIGN_LINE);

      expect(
        listCheckpoints(rig).filter((c) => c.kind === 'managed-artifact-reconcile'),
      ).toHaveLength(0);
      expect(
        readLossEvents(rig.contentDir).filter(
          (e) => e.site === 'managed-artifact-reconcile' && e.docName === docName,
        ),
      ).toHaveLength(0);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );
});
