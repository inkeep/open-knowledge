import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { initShadowRepo, saveInMemoryCheckpoint } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import {
  agentWriteMd,
  awaitWipCommits,
  createTestServer,
  pollDiskContentStable,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

describe('D8 silent-checkpoint restore floor (end-to-end HTTP)', () => {
  test('a silent extension-less checkpoint surfaces in history, reads back, and restores', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
    const docName = `silent-restore-${randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# Live content\n\ncurrent body\n', {
      docName,
      position: 'replace',
    });
    await awaitWipCommits(server, docName, 1);

    const shadow = await initShadowRepo(server.contentDir);
    const recovered = '# Recovered content\n\nthe keystroke that was almost lost\n';
    const silentSha = await saveInMemoryCheckpoint(shadow, '', {
      kind: 'bridge-merge-loss',
      docName,
      contents: recovered,
      branch: 'main',
      label: 'Before concurrent merge @ 2026-05-05T12:00:00Z',
      metadata: { lostSubstrings: ['the keystroke'] },
    });

    const histRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
    );
    expect(histRes.status).toBe(200);
    const hist = (await histRes.json()) as {
      entries: Array<{ sha: string; type: string; checkpoint?: { kind?: string } | null }>;
    };
    const row = hist.entries.find((e) => e.sha === silentSha);
    expect(row).toBeDefined();
    expect(row?.type).toBe('checkpoint');
    expect(row?.checkpoint?.kind).toBe('bridge-merge-loss');

    const readRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${silentSha}?docName=${encodeURIComponent(docName)}`,
    );
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { content: string };
    expect(read.content).toBe(recovered);

    const rbRes = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, commitSha: silentSha }),
    });
    expect(rbRes.status).toBe(200);

    const disk = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('Recovered content'),
      { timeoutMs: 5000, settleMs: 200 },
    );
    expect(disk).toContain('Recovered content');
    expect(disk).not.toContain('current body');
  }, 30_000);
});
