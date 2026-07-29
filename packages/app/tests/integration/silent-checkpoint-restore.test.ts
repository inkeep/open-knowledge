/**
 * End-to-end restore floor for silent (extension-less) checkpoints.
 *
 * `saveInMemoryCheckpoint` writes the recovered blob at the extension-LESS
 * docName tree path (`<root>/foo`), because the Hocuspocus doc name that flows
 * through the CRDT layer is already extension-less. The restore read paths
 * (`GET /api/history`, `GET /api/history/:sha`, `POST /api/rollback`) used to
 * probe only the extension-full disk path (`<root>/foo.md`), so a silent
 * checkpoint's row was dropped from the timeline and its sha 404'd — the
 * rescued content was reachable by no API at all. This drives the real HTTP
 * handlers against a real shadow repo to prove the floor is reachable
 * end-to-end.
 */
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

    // Live content the user is currently editing.
    await agentWriteMd(server.port, '# Live content\n\ncurrent body\n', {
      docName,
      position: 'replace',
    });
    await awaitWipCommits(server, docName, 1);

    // Seed a silent bridge-merge-loss checkpoint the way production does:
    // contentRoot '' → bare (extension-less) docName tree path, matching the
    // handler's extension-less resolution twin.
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

    // 1) The silent-kind row reaches the /api/history payload with its kind.
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

    // 2) /api/history/:sha reads the checkpointed content back out.
    const readRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${silentSha}?docName=${encodeURIComponent(docName)}`,
    );
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as { content: string };
    expect(read.content).toBe(recovered);

    // 3) /api/rollback restores the checkpointed content into the live doc via
    //    the same replaceRawBody spine as any rollback.
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
