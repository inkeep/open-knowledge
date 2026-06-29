
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import {
  agentWriteMd,
  createRestartableServer,
  createTestClient,
  createTestServer,
  pollDiskContentStable,
  pollUntil,
  schema,
  type TestServer,
} from './test-harness';

type AnyServer = { instance: TestServer['instance'] };

function serverFragment(server: AnyServer, docName: string): Y.XmlFragment | undefined {
  return server.instance.hocuspocus.documents.get(docName)?.getXmlFragment('default');
}

function fragmentVisibleText(fragment: Y.XmlFragment): string {
  return yXmlFragmentToProseMirrorRootNode(fragment, schema).textContent;
}

describe('WYSIWYG &#x20; literal after close + cold reopen (the reported bug)', () => {
  test('agent write of a boundary space, cold restart, reopen: shows a space, bytes stable', async () => {
    let server = await createRestartableServer({ debounce: 100, maxDebounce: 400 });
    const docName = `x20-restart-${crypto.randomUUID()}`;
    const docFile = join(server.contentDir, `${docName}.md`);
    try {
      await agentWriteMd(server.port, 'before&#x20;', {
        docName,
        position: 'replace',
      });
      const preDisk = await pollDiskContentStable(docFile, (c) => c.includes('before&#x20;'), {
        timeoutMs: 8000,
        settleMs: 300,
      });
      expect(preDisk).toContain('before&#x20;');

      server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });

      const client = await createTestClient(server.port, docName);
      try {
        await pollUntil(() => serverFragment(server, docName) !== undefined, 10_000, 50);
        const fragment = serverFragment(server, docName);
        if (!fragment) throw new Error('doc not loaded on server after cold restart');

        const shown = fragmentVisibleText(fragment);
        expect(shown).not.toContain('&#x20;');
        expect(shown).toContain('before ');

        const postDisk = await pollDiskContentStable(docFile, (c) => c.includes('before&#x20;'), {
          timeoutMs: 5000,
          settleMs: 300,
        });
        expect(postDisk).toContain('before&#x20;');
      } finally {
        await client.cleanup();
      }
    } finally {
      await server.shutdown();
    }
  }, 30_000);
});

describe('WYSIWYG &#x20; literal — pure cold load of a doc already stored with &#x20;', () => {
  let server: TestServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.cleanup();
    server = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test('cold load shows a real space, not literal &#x20;, and bytes are byte-stable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-x20-coldload-'));
    const docName = `x20-${crypto.randomUUID()}`;
    writeFileSync(join(dir, `${docName}.md`), 'alpha&#x20;\n', 'utf-8');

    server = await createTestServer({ contentDir: dir, keepContentDir: true });
    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(
        () => serverFragment(server as TestServer, docName) !== undefined,
        10_000,
        50,
      );
      const fragment = serverFragment(server, docName);
      if (!fragment) throw new Error('doc not loaded on server');

      const shown = fragmentVisibleText(fragment);
      expect(shown).not.toContain('&#x20;'); // RED before fix
      expect(shown).toContain('alpha ');

      const disk = await pollDiskContentStable(
        join(dir, `${docName}.md`),
        (c) => c.includes('alpha&#x20;'),
        { timeoutMs: 5000, settleMs: 300 },
      );
      expect(disk).toContain('alpha&#x20;');
    } finally {
      await client.cleanup();
    }
  }, 30_000);

  test('cold load of ADJACENT refs shows multiple spaces and keeps bytes byte-stable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ok-x20-adjacent-'));
    const docName = `x20adj-${crypto.randomUUID()}`;
    writeFileSync(join(dir, `${docName}.md`), 'gamma&#x20;&#x20;delta\n', 'utf-8');

    server = await createTestServer({ contentDir: dir, keepContentDir: true });
    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(
        () => serverFragment(server as TestServer, docName) !== undefined,
        10_000,
        50,
      );
      const fragment = serverFragment(server, docName);
      if (!fragment) throw new Error('doc not loaded on server');

      const shown = fragmentVisibleText(fragment);
      expect(shown).not.toContain('&#x20;');
      expect(shown).toContain('gamma  delta'); // two real spaces

      const disk = await pollDiskContentStable(
        join(dir, `${docName}.md`),
        (c) => c.includes('gamma&#x20;&#x20;delta'),
        { timeoutMs: 5000, settleMs: 300 },
      );
      expect(disk).toContain('gamma&#x20;&#x20;delta');
    } finally {
      await client.cleanup();
    }
  }, 30_000);
});
