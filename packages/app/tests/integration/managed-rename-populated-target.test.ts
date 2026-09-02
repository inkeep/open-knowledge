import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { createMultiClientContext, createRestartableServer, pollUntil } from './test-harness';

const SOURCE_CONTENT = `# Source Doc

Content from source.

[[source-sibling]]
`;

const TARGET_CONTENT = `# Target Doc

Content from target.

[[target-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T8: Managed-rename with populated target', () => {
  test('API refuses rename when destination exists; no Y.Doc mutation occurs', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    writeFileSync(join(server.contentDir, 'source-doc.md'), SOURCE_CONTENT, 'utf-8');
    writeFileSync(join(server.contentDir, 'target-doc.md'), TARGET_CONTENT, 'utf-8');

    await wait(300);

    const ctx = await createMultiClientContext({
      server,
      docName: 'target-doc',
      clientCount: 1,
    });
    cleanups.push(() => ctx.cleanup());

    await pollUntil(
      () =>
        ctx.pools[0]
          .getActive()
          ?.provider.document.getText('source')
          .toString()
          .includes('target-sibling') ?? false,
      8000,
      50,
    );

    const preEntry = ctx.pools[0].getActive();
    if (!preEntry) throw new Error('pool[0] has no active entry pre-rename');
    const preDoc = preEntry.provider.document;
    const preText = preDoc.getText('source').toString();
    const preClientIdSize = preDoc.store.clients.size;

    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        fromPath: 'source-doc',
        toPath: 'target-doc',
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-already-exists');
    expect(String(body.title)).toContain('already exists');

    await wait(500);

    const postText = preDoc.getText('source').toString();
    const postClientIdSize = preDoc.store.clients.size;

    expect(postText).toBe(preText);
    expect(postClientIdSize).toBe(preClientIdSize);
    expect((postText.match(/target-sibling/g) ?? []).length).toBe(1);
    expect((postText.match(/source-sibling/g) ?? []).length).toBe(0);
  }, 30_000);
});
