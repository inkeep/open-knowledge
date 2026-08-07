/**
 * The templates-as-content payoff: template files inherit the full content
 * watcher, so external edits, brand-new folders, deletes, renames, and merge
 * conflict markers behave like any other doc — with zero template-specific
 * watcher code. Before the migration a template was watched by a dedicated
 * polling watcher whose roots were frozen at boot (no new-folder rescue, no
 * unlink, no rename pairing, no conflict classification); this suite proves
 * those four capabilities against the real integration harness (real OS
 * watcher, real filesystem, real Hocuspocus server, real WS client).
 *
 * The external-edit reconcile into an open template doc is already pinned in
 * `managed-artifact-doc.test.ts` at the content name; it is not repeated here.
 * The chokidar-backend twins for the new-folder and conflict cases live at the
 * watcher DiskEvent seam in `packages/server/src/file-watcher-chokidar-fallback.test.ts`
 * (the full server harness has no forceBackend knob).
 */

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

/**
 * A content directory pre-seeded with an empty `.ok/config.yml` so `.ok` and
 * its descendants are present in the watcher's initial recursive scan. Tests
 * that need a template watched from boot seed it here before `createTestServer`.
 */
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

/**
 * Poll the watcher's in-memory file index (via `GET /api/pages`, which iterates
 * the full `getFileIndex()` with no hidden-doc filter, so template content docs
 * appear) until `docName` shows up. `/api/documents` is the sidebar view and
 * hides `.ok` rows, so it never surfaces a template; the index is the honest
 * signal that the watcher saw the file (opening a client hydrates from disk via
 * `onLoadDocument` regardless of the index, so client hydration alone would not
 * prove the folder was indexed).
 *
 * One-shot rescan net: on Linux CI `@parcel/watcher` can drop the folder-create
 * for a deep, freshly-created subdir (inotify subwatch registration race). The
 * rescan re-runs the seed walk (NOT a server restart — the server stays up and
 * loaded docs are untouched). On macOS FSEvents delivers the folder-create live,
 * so the rescan never fires; the pure-live folder-create capability is pinned
 * deterministically by the chokidar DiskEvent twin in file-watcher-chokidar-fallback.
 */
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
      // A folder absent at boot. The dedicated template watcher froze its roots at
      // boot, so a template born here was invisible until restart; the content
      // watcher's folder-create rescue indexes it live.
      const folder = `folder-${randomUUID().slice(0, 8)}`;
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `${folder}/.ok/templates/${name}`;
      const src =
        '---\ntitle: Standup\ndescription: a standup template\n---\n\n# {{date}}\n\nStandup.\n';

      const tplFile = resolve(rig.contentDir, folder, '.ok', 'templates', `${name}.md`);
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, src, 'utf-8');

      // Index without restart: the watcher's file index now carries the template.
      await awaitPageIndexed(rig, docName);

      // Reconcile without restart: the freshly-indexed doc opens and hydrates.
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
      // Watched from boot; a moderate store debounce keeps the dirty edit below
      // pending so the external delete lands while a store is scheduled — the
      // exact resurrection vector the old managed store left open for templates.
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

      // Dirty the doc: this edit is live in the server Y.Doc but held off disk by
      // the store debounce.
      client.doc.transact(() => client.ytext.insert(client.ytext.length, 'pending edit\n'));
      await pollUntil(
        () =>
          serverDoc(rig, docName)?.getText('source').toString().includes('pending edit') ?? false,
        8000,
      );

      // External unlink.
      rmSync(tplFile);

      // Clean unlink: the delete handler force-unloads the doc, which skips the
      // store, so the scheduled debounce cannot re-create the file.
      await pollUntil(() => serverDoc(rig, docName) === undefined, 15000);
      expect(readTestDoc(rig.contentDir, docName)).toBe('');

      // No resurrection: a surviving pending store would flush within maxDebounce.
      // Waiting past it and re-asserting absence is a bounded negative-window
      // check (there is no positive event to wait on for "a file was not written").
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
      // Both names live in the same boot-watched `.ok/templates/` folder. The
      // watcher pairs the delete+create by content hash within one batch and
      // marks the loaded doc `renamed` (a create+delete would instead mark the
      // old doc `deleted-upstream`), so the lifecycle status is the pairing oracle.
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

      // Load the doc so `case 'rename'` has a target to stamp.
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

      // Open the doc so the watcher's conflict classification has a loaded target
      // (`handleDiskEvent` case 'conflict' returns early when the doc is not loaded).
      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === clean, 8000);

      // A git merge left conflict markers in the file. The content watcher's
      // reconciliation classifies marker-laden disk content into the conflict
      // lifecycle rather than ingesting the marker bytes — the previously-dead
      // conflict gate now applies to templates.
      const conflicted =
        '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\n<<<<<<< HEAD\nours.\n=======\ntheirs.\n>>>>>>> branch\n';
      writeFileSync(tplFile, conflicted, 'utf-8');

      await pollUntil(() => lifecycleStatus(rig, docName) === 'conflict', 15000);
      expect(lifecycleStatus(rig, docName)).toBe('conflict');
      expect(serverDoc(rig, docName)?.getMap('lifecycle').get('reason')).toBe('conflict-markers');
      // The marker bytes never enter the CRDT — the doc keeps its clean body.
      expect(client.ytext.toString()).not.toContain('<<<<<<<');

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});
