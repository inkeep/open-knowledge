import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  readTestDoc,
  type TestServer,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

function seedContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-template-watcher-'));
  mkdirSync(resolve(dir, '.ok'), { recursive: true });
  writeFileSync(resolve(dir, '.ok', 'config.yml'), '', 'utf-8');
  return dir;
}

function serverDoc(rig: TestServer, docName: string) {
  return rig.instance.hocuspocus.documents.get(docName);
}

function lifecycleStatus(rig: TestServer, docName: string): unknown {
  return serverDoc(rig, docName)?.getMap('lifecycle').get('status');
}

async function awaitPageIndexed(
  rig: TestServer,
  docName: string,
  timeoutMs = 45_000,
): Promise<void> {
  const start = Date.now();
  let rescued = false;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`http://127.0.0.1:${rig.port}/api/pages`).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { pages?: Array<{ docName: string }> };
      if (data.pages?.some((p) => p.docName === docName)) return;
    }
    if (!rescued && Date.now() - start >= 2_000) {
      rescued = true;
      await fetch(`http://127.0.0.1:${rig.port}/api/test-rescan-files`, { method: 'POST' }).catch(
        () => null,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`awaitPageIndexed: ${docName} not indexed within ${timeoutMs}ms`);
}

describe('template watcher capabilities — content pipeline parity (FR4)', () => {
  test(
    'a template created in a folder that did not exist at boot indexes and reconciles without a restart',
    async () => {
      server = await createTestServer();
      const rig = server;
      const folder = `folder-${randomUUID().slice(0, 8)}`;
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `${folder}/.ok/templates/${name}`;
      const src =
        '---\ntitle: Standup\ndescription: a standup template\n---\n\n# {{date}}\n\nStandup.\n';

      const tplFile = resolve(rig.contentDir, folder, '.ok', 'templates', `${name}.md`);
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, src, 'utf-8');

      await awaitPageIndexed(rig, docName);

      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === src, 8000);
      expect(client.ytext.toString()).toBe(src);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );

  test(
    'a template deleted on disk closes the doc cleanly and is not resurrected by a debounced store',
    async () => {
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;
      const contentDir = seedContentDir();
      const tplFile = resolve(contentDir, '.ok', 'templates', `${name}.md`);
      const src = '---\ntitle: T\ndescription: d\n---\n\n# Template\n\nv1.\n';
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, src, 'utf-8');

      server = await createTestServer({ contentDir, debounce: 200, maxDebounce: 800 });
      const rig = server;

      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === src, 8000);

      client.doc.transact(() => client.ytext.insert(client.ytext.length, 'pending edit\n'));
      await pollUntil(
        () =>
          serverDoc(rig, docName)?.getText('source').toString().includes('pending edit') ?? false,
        8000,
      );

      rmSync(tplFile);

      await pollUntil(() => serverDoc(rig, docName) === undefined, 15000);
      expect(readTestDoc(rig.contentDir, docName)).toBe('');

      await new Promise((r) => setTimeout(r, 1200));
      expect(readTestDoc(rig.contentDir, docName)).toBe('');
      expect(serverDoc(rig, docName)).toBeUndefined();

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'a template renamed on disk is paired as a rename, not an unrelated create plus delete',
    async () => {
      const from = `a-${randomUUID().slice(0, 8)}`;
      const to = `b-${randomUUID().slice(0, 8)}`;
      const fromDoc = `.ok/templates/${from}`;
      const toDoc = `.ok/templates/${to}`;
      const contentDir = seedContentDir();
      const fromFile = resolve(contentDir, '.ok', 'templates', `${from}.md`);
      const toFile = resolve(contentDir, '.ok', 'templates', `${to}.md`);
      const src = '---\ntitle: T\ndescription: d\n---\n\n# Template\n\nBody.\n';
      mkdirSync(resolve(fromFile, '..'), { recursive: true });
      writeFileSync(fromFile, src, 'utf-8');

      server = await createTestServer({ contentDir, debounce: 100, maxDebounce: 400 });
      const rig = server;

      const client = await createTestClient(rig.port, fromDoc, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === src, 8000);

      renameSync(fromFile, toFile);

      await pollUntil(() => lifecycleStatus(rig, fromDoc) === 'renamed', 15000);
      expect(lifecycleStatus(rig, fromDoc)).toBe('renamed');
      expect(serverDoc(rig, fromDoc)?.getMap('lifecycle').get('newPath')).toBe(toDoc);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'conflict markers written to a template file classify the open doc into the conflict lifecycle',
    async () => {
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;
      const contentDir = seedContentDir();
      const tplFile = resolve(contentDir, '.ok', 'templates', `${name}.md`);
      const clean = '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\nv1.\n';
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, clean, 'utf-8');

      server = await createTestServer({ contentDir, debounce: 100, maxDebounce: 400 });
      const rig = server;

      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === clean, 8000);

      const conflicted =
        '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\n<<<<<<< HEAD\nours.\n=======\ntheirs.\n>>>>>>> branch\n';
      writeFileSync(tplFile, conflicted, 'utf-8');

      await pollUntil(() => lifecycleStatus(rig, docName) === 'conflict', 15000);
      expect(lifecycleStatus(rig, docName)).toBe('conflict');
      expect(serverDoc(rig, docName)?.getMap('lifecycle').get('reason')).toBe('conflict-markers');
      expect(client.ytext.toString()).not.toContain('<<<<<<<');

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});
