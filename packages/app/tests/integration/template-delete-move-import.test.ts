/**
 * Behavioral coverage for the three template lifecycle routes whose
 * content-doc handling previously had only source-ordering pins:
 *
 *   1. DELETE tears down the live content doc and marks the content doc name
 *      removed, so a stale IDB-cached tab is rejected on reconnect instead of
 *      resurrecting the file (parity with ordinary doc deletion).
 *   2. MOVE tears down the FROM content doc and marks the FROM name removed.
 *      The move handler records the source as DELETED (not renamed), so a stale
 *      connection to the old name is refused, not redirected.
 *   3. IMPORT routes the composed bytes THROUGH the content doc's CRDT Y.Text,
 *      not a filesystem-direct write.
 *
 * Everything runs against the real Hocuspocus server, real persistence branch,
 * real removal-redirect auth guard, and real WS clients — no mocks. The removal
 * guard's rejection is observed exactly as production does it: a fresh provider
 * connect fires `authenticationFailed` carrying the typed reason.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { parseAuthRejectionWire } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
  wait,
} from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function serverDoc(rig: TestServer, docName: string) {
  return rig.instance.hocuspocus.documents.get(docName);
}

function putTemplate(
  port: number,
  folder: string,
  name: string,
  body: string,
  frontmatter: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name, body, frontmatter }),
  });
}

function deleteTemplate(port: number, folder: string, name: string): Promise<Response> {
  const qs = new URLSearchParams({ name, folder });
  return fetch(`http://127.0.0.1:${port}/api/template?${qs.toString()}`, { method: 'DELETE' });
}

function moveTemplate(
  port: number,
  body: { fromFolder: string; fromName: string; toFolder: string; toName: string },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function importTemplate(port: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/template/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Write a source doc and wait until it has flushed to disk (import reads the file). */
async function writeSource(
  port: number,
  contentDir: string,
  docName: string,
  markdown: string,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, position: 'replace', docName }),
  });
  if (res.status !== 200) throw new Error(`agent-write-md failed for ${docName}: ${res.status}`);
  const filePath = join(contentDir, `${docName}.md`);
  for (let i = 0; i < 100; i++) {
    if (existsSync(filePath)) return;
    await wait(50);
  }
  throw new Error(`source ${docName}.md never flushed to disk`);
}

/**
 * Connect a bare provider expecting the removal-redirect guard to reject it;
 * return the typed rejection. Fails if the connection is admitted (synced)
 * instead. Mirrors the helper in `delete-durability.test.ts`.
 */
async function expectAuthRejection(
  port: number,
  docName: string,
): Promise<ReturnType<typeof parseAuthRejectionWire>> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docName,
    document: doc,
  });
  try {
    const reason = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`authenticationFailed did not fire for ${docName}`)),
        15_000,
      );
      provider.on('authenticationFailed', (payload: { reason: string }) => {
        clearTimeout(timer);
        resolve(payload.reason);
      });
      provider.on('synced', () => {
        clearTimeout(timer);
        reject(new Error(`connection to ${docName} was unexpectedly admitted`));
      });
    });
    return parseAuthRejectionWire(reason);
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

describe('template delete/move/import — content-doc lifecycle', () => {
  test(
    'DELETE tears down the open content doc and marks its name removed',
    async () => {
      const rig = server;
      const name = `daily-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;

      expect(
        (await putTemplate(rig.port, '', name, '# Daily\n\nv1.\n', { title: 'Daily' })).status,
      ).toBe(200);

      // Open the content doc (a user viewing the template) and HOLD the
      // connection — so the only thing that can unload the doc is the DELETE
      // handler's teardown, not a last-connection-closed unload.
      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      try {
        await pollUntil(() => client.ytext.toString().includes('# Daily'), 8000);
        expect(serverDoc(rig, docName)).toBeDefined();

        const del = await deleteTemplate(rig.port, '', name);
        expect(del.status).toBe(200);
        expect((await del.json()).existed).toBe(true);

        // Teardown: the handler awaits captureAndCloseDocuments before
        // responding, so the live doc is unloaded by the time DELETE returns.
        expect(serverDoc(rig, docName)).toBeUndefined();
        expect(existsSync(join(rig.contentDir, '.ok', 'templates', `${name}.md`))).toBe(false);

        // Removal-guard registration: a fresh WS connect to the content doc name
        // is refused as deleted — the production consequence that stops an
        // IDB-cached tab from resurrecting the file. This is what proves
        // setDeleted ran on the CONTENT doc name (not the retired synthetic one).
        expect((await expectAuthRejection(rig.port, docName)).kind).toBe('doc-deleted');
      } finally {
        await client.cleanup();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'MOVE tears down the FROM content doc and marks the FROM name removed',
    async () => {
      const rig = server;
      const fromName = `note-${randomUUID().slice(0, 8)}`;
      const toName = `${fromName}-moved`;
      const fromDoc = `.ok/templates/${fromName}`;

      expect(
        (await putTemplate(rig.port, '', fromName, '# Note\n\nv1.\n', { title: 'Note' })).status,
      ).toBe(200);

      const client = await createTestClient(rig.port, fromDoc, { skipInvariantWatcher: true });
      try {
        await pollUntil(() => client.ytext.toString().includes('# Note'), 8000);
        expect(serverDoc(rig, fromDoc)).toBeDefined();

        const move = await moveTemplate(rig.port, {
          fromFolder: '',
          fromName,
          toFolder: '',
          toName,
        });
        expect(move.status).toBe(200);

        // FROM-side teardown: the source doc is torn down before the relocate,
        // so its persistence branch can't re-store at the now-stale path.
        expect(serverDoc(rig, fromDoc)).toBeUndefined();
        expect(existsSync(join(rig.contentDir, '.ok', 'templates', `${fromName}.md`))).toBe(false);
        expect(existsSync(join(rig.contentDir, '.ok', 'templates', `${toName}.md`))).toBe(true);

        // The handler marks the OLD name removed synchronously ("parity with
        // ordinary doc deletion"); the content watcher's rename-pairing may then
        // upgrade that entry to a redirect toward the new name. Either way the
        // old name refuses a fresh connect, so a stale IDB-cached tab cannot
        // resurrect the moved file — the removal-guard parity the move exists for.
        const rejection = await expectAuthRejection(rig.port, fromDoc);
        expect(['doc-deleted', 'rename-redirect']).toContain(rejection.kind);
      } finally {
        await client.cleanup();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'IMPORT routes the composed bytes through the content doc, not a fs-direct write',
    async () => {
      const rig = server;
      const marker = `imported-body-${randomUUID().slice(0, 8)}`;
      const sourceName = `src-${randomUUID().slice(0, 8)}`;
      const tplName = `tpl-${randomUUID().slice(0, 8)}`;
      const tplDoc = `.ok/templates/${tplName}`;

      await writeSource(
        rig.port,
        rig.contentDir,
        sourceName,
        `---\ntitle: Source Title\n---\n\n# Heading\n\n${marker}\n`,
      );

      // Open the target content doc BEFORE importing — it does not exist yet, so
      // it opens empty. This is the CRDT-routing discriminator: a fs-direct
      // create of a NEW file records only the disk index (the watcher's create
      // arm never applies to a loaded doc), so it would leave this open doc
      // empty; only a write routed through the content doc fills the client.
      const client = await createTestClient(rig.port, tplDoc, { skipInvariantWatcher: true });
      try {
        expect(client.ytext.toString()).toBe('');

        const imp = await importTemplate(rig.port, {
          sourcePath: sourceName,
          targetFolder: '',
          name: tplName,
        });
        expect(imp.status).toBe(200);

        // The composed bytes arrive in the SAME Y.Doc the client is bound to —
        // proof the import wrote through the content doc. The unique body marker
        // reaching an already-open doc is only possible via the CRDT path.
        await pollUntil(() => client.ytext.toString().includes(marker), 8000);
        const live = client.ytext.toString();
        expect(live).toContain(marker); // imported body
        expect(live).toContain('template:'); // composed identity block
        expect(live).toContain('Source Title'); // title lifted into the template block

        // The persisted file equals the doc content (the flush wrote the doc).
        const tplFile = join(rig.contentDir, '.ok', 'templates', `${tplName}.md`);
        expect(existsSync(tplFile)).toBe(true);
        expect(readFileSync(tplFile, 'utf-8')).toBe(live);
      } finally {
        await client.cleanup();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'PUT, import, and move register the template in the file index by the time the response returns',
    async () => {
      const rig = server;

      // All three writes land in a BRAND-NEW `<folder>/.ok/templates/` dir
      // created by the operation itself. That is the watcher's weak spot: on
      // Linux the create event for a file written into a just-created subdir
      // can be dropped outright (the recursive inotify subwatch registers
      // async). The handlers close it by registering the doc synchronously
      // before responding — so a SINGLE un-polled /api/pages read right after
      // the response is the deterministic oracle. A poll loop here would mask
      // a dropped event by letting the eventual watcher path win instead.
      async function pagesHas(docName: string): Promise<boolean> {
        const res = await fetch(`http://127.0.0.1:${rig.port}/api/pages`);
        expect(res.ok).toBe(true);
        const data = (await res.json()) as { pages?: Array<{ docName: string }> };
        return data.pages?.some((p) => p.docName === docName) ?? false;
      }

      const putFolder = `fresh-put-${randomUUID().slice(0, 8)}`;
      const putName = `tpl-${randomUUID().slice(0, 8)}`;
      const put = await putTemplate(rig.port, putFolder, putName, '# Standup\n\nBody.\n', {
        title: 'Standup',
      });
      expect(put.status).toBe(200);
      expect(await pagesHas(`${putFolder}/.ok/templates/${putName}`)).toBe(true);

      const sourceName = `src-idx-${randomUUID().slice(0, 8)}`;
      await writeSource(rig.port, rig.contentDir, sourceName, '# Imported\n\nBody.\n');
      const impFolder = `fresh-imp-${randomUUID().slice(0, 8)}`;
      const impName = `tpl-${randomUUID().slice(0, 8)}`;
      const imp = await importTemplate(rig.port, {
        sourcePath: sourceName,
        targetFolder: impFolder,
        name: impName,
      });
      expect(imp.status).toBe(200);
      expect(await pagesHas(`${impFolder}/.ok/templates/${impName}`)).toBe(true);

      // MOVE into a folder whose `.ok/templates/` did not previously exist —
      // the relocate mkdirs the destination dir, so the same race applies on
      // the same terms as put/import.
      const moveToFolder = `fresh-mov-${randomUUID().slice(0, 8)}`;
      const mov = await moveTemplate(rig.port, {
        fromFolder: putFolder,
        fromName: putName,
        toFolder: moveToFolder,
        toName: putName,
      });
      expect(mov.status).toBe(200);
      expect(await pagesHas(`${moveToFolder}/.ok/templates/${putName}`)).toBe(true);
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );

  test(
    'rejects a `..` folder that escapes the content directory on every mutation route',
    async () => {
      const rig = server;

      // `validateFolderRel` is the sole path-escape guard for the template
      // routes now that `templateAbsPath` (and its path-escape unit test) are
      // gone — the request schema accepts any `folder` string. All four
      // handlers share the guard, so all four call sites are pinned (PUT, both
      // move sides, DELETE, IMPORT) — a future refactor that splits one onto a
      // different validation helper fails loud.
      const put = await putTemplate(rig.port, '../etc', 'evil', '# x\n', { title: 'x' });
      expect(put.status).toBe(400);
      expect((await put.json()).type).toBe('urn:ok:error:invalid-request');

      const moveFrom = await moveTemplate(rig.port, {
        fromFolder: '../etc',
        fromName: 'evil',
        toFolder: '',
        toName: 'safe',
      });
      expect(moveFrom.status).toBe(400);
      expect((await moveFrom.json()).type).toBe('urn:ok:error:invalid-request');

      const moveTo = await moveTemplate(rig.port, {
        fromFolder: '',
        fromName: 'safe',
        toFolder: '../etc',
        toName: 'evil',
      });
      expect(moveTo.status).toBe(400);
      expect((await moveTo.json()).type).toBe('urn:ok:error:invalid-request');

      const del = await deleteTemplate(rig.port, '../etc', 'evil');
      expect(del.status).toBe(400);
      expect((await del.json()).type).toBe('urn:ok:error:invalid-request');

      // Import validates `targetFolder` only after resolving the source, so the
      // pin needs a real source doc — otherwise a source-not-found error would
      // mask a weakened folder guard.
      const escSource = `src-esc-${randomUUID().slice(0, 8)}`;
      await writeSource(rig.port, rig.contentDir, escSource, '# Esc\n\nBody.\n');
      const imp = await importTemplate(rig.port, {
        sourcePath: escSource,
        targetFolder: '../etc',
        name: 'evil',
      });
      expect(imp.status).toBe(400);
      expect((await imp.json()).type).toBe('urn:ok:error:invalid-request');
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});
