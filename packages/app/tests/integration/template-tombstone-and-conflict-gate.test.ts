/**
 * Two guarantees the templates-as-content cutover must hold at the LIVE server,
 * proven against the real Hocuspocus server + real persistence branch + real OS
 * watcher (not mocks):
 *
 *  1. Tombstone quarantine — a stale `__template__/…` doc name (an old client or
 *     a pre-upgrade bookmark) opened against the new server seeds nothing and
 *     stores nothing, so it can never become a SECOND CRDT doc for a template
 *     file nor write a literal `__template__/…` file. Either would be the
 *     double-doc corruption the migration's atomicity rule forbids.
 *
 *  2. Live conflict gate — a template is a content doc now, so a template file
 *     bearing merge conflict markers drives its Y.Doc into the conflict
 *     lifecycle, and the previously-dead conflict gate refuses every mutating
 *     template route (PUT, move, DELETE, and import) until the conflict is
 *     resolved.
 *
 * The watcher CLASSIFICATION into the conflict lifecycle is pinned in
 * `template-watcher-capabilities.test.ts`; this suite pins the HTTP gate's
 * refusal on top of that classification. The structural handler asymmetries
 * (which routes signal `files`, move's FROM-side-only gate, the fs-direct
 * content-edit tail) are pinned in `template-handler-contract.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
  wait,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

/**
 * A content directory pre-seeded with an empty `.ok/config.yml` so `.ok` and its
 * descendants are present in the watcher's initial recursive scan — a template
 * seeded here is watched from boot.
 */
function seedContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-template-gate-'));
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

describe('template tombstone quarantine (FR3)', () => {
  test(
    'a stale __template__ doc opened live seeds nothing, no-ops on write, and creates no file',
    async () => {
      server = await createTestServer({ debounce: 100, maxDebounce: 400 });
      const rig = server;
      const folder = `notes-${randomUUID().slice(0, 8)}`;
      const name = `daily-${randomUUID().slice(0, 8)}`;
      const syntheticName = `__template__/${folder}/${name}`;

      // The tombstone load guard seeds nothing: the synthetic doc opens EMPTY.
      const client = await createTestClient(rig.port, syntheticName, {
        skipInvariantWatcher: true,
      });
      expect(client.ytext.toString()).toBe('');

      // Write to the synthetic doc — proving the store guard is exercised on a
      // dirty, synced doc (not a never-touched one). The store guard no-ops for a
      // `__template__` name, so the debounced store fires and lands nothing.
      client.doc.transact(() =>
        client.ytext.insert(client.ytext.length, 'stale synthetic write\n'),
      );
      await pollUntil(
        () =>
          serverDoc(rig, syntheticName)?.getText('source').toString().includes('stale synthetic') ??
          false,
        8000,
      );

      // Wait past maxDebounce so any scheduled store has fired-and-no-op'd, then
      // assert the never-creates-file oracle — a bounded negative-window check
      // (there is no positive event to wait on for "a file was not written").
      await wait(700);

      // No literal `__template__/…` file, and nothing leaked to the content
      // branch at the path the synthetic name would map to. Either would be the
      // double-doc corruption the tombstone exists to prevent.
      expect(existsSync(join(rig.contentDir, '__template__', folder, `${name}.md`))).toBe(false);
      expect(existsSync(join(rig.contentDir, folder, '.ok', 'templates', `${name}.md`))).toBe(
        false,
      );
      expect(existsSync(join(rig.contentDir, '__template__'))).toBe(false);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});

describe('template live conflict gate (FR5)', () => {
  test(
    'conflict markers in a template file make the live gate refuse PUT, move, DELETE, and import (previously dead)',
    async () => {
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;
      const contentDir = seedContentDir();
      const tplFile = resolve(contentDir, '.ok', 'templates', `${name}.md`);
      const clean = '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\nv1.\n';
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, clean, 'utf-8');

      // An ordinary source doc for the import route — import reads the source
      // BEFORE it reaches the target conflict gate, so the source must exist and
      // be loadable; a missing source would 404 short of the gate under test.
      const srcName = `imp-src-${randomUUID().slice(0, 8)}`;
      writeFileSync(resolve(contentDir, `${srcName}.md`), '# Source\n\nimport me.\n', 'utf-8');

      server = await createTestServer({ contentDir, debounce: 100, maxDebounce: 400 });
      const rig = server;

      // Open the doc so the watcher's conflict classification has a loaded target
      // (the disk-event conflict arm returns early when the doc is not loaded).
      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === clean, 8000);

      // A git merge left conflict markers in the file → conflict lifecycle.
      const conflicted =
        '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\n<<<<<<< HEAD\nours.\n=======\ntheirs.\n>>>>>>> branch\n';
      writeFileSync(tplFile, conflicted, 'utf-8');
      await pollUntil(() => lifecycleStatus(rig, docName) === 'conflict', 15000);

      // PUT refuses: the previously-dead conflict gate now looks up the content
      // doc name and finds it mid-conflict — the CRDT paired-write path would
      // otherwise clobber a doc the user is mid-resolving.
      const put = await fetch(`http://127.0.0.1:${rig.port}/api/template`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: '', name, body: '# clobber', frontmatter: { title: 'X' } }),
      });
      expect(put.status).toBe(409);
      expect(put.headers.get('content-type')).toBe('application/problem+json');
      expect(((await put.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      // Move refuses on the FROM side: the move gate keys on `fromName`, so moving
      // the conflicted source refuses before tearing the source doc down.
      const movedName = `${name}moved`;
      const move = await fetch(`http://127.0.0.1:${rig.port}/api/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromFolder: '', fromName: name, toFolder: '', toName: movedName }),
      });
      expect(move.status).toBe(409);
      expect(((await move.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      // DELETE refuses too (query-param transport): the gate keys on the content
      // doc name, so removing a mid-conflict template is refused before the file
      // is touched. Its call site went live in this migration.
      const del = await fetch(
        `http://127.0.0.1:${rig.port}/api/template?folder=&name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(409);
      expect(((await del.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      // Import refuses when its TARGET template is mid-conflict: the gate keys on
      // the target (targetFolder, name), so importing over the conflicted
      // template is refused. Its call site went live in this migration too.
      const imp = await fetch(`http://127.0.0.1:${rig.port}/api/template/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: srcName, name, targetFolder: '' }),
      });
      expect(imp.status).toBe(409);
      expect(((await imp.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      // No clobber, no move: the file still holds the markers and no moved file
      // was created. All four refusals above left the conflicted template intact.
      expect(readFileSync(tplFile, 'utf-8')).toBe(conflicted);
      expect(existsSync(resolve(contentDir, '.ok', 'templates', `${movedName}.md`))).toBe(false);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});
