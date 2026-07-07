/**
 * Unit tests for `createConflictLifecycleSeedExtension`.
 *
 * Exercises the `afterLoadDocument` hook directly with a mocked SyncEngine
 * and a real Y.Doc. The server-side `case 'conflict'` branch already covers
 * the already-loaded-doc path (file-watcher → lifecycle); these tests pin
 * the previously-uncovered race: conflict landed on disk while the doc was
 * NOT loaded, and the client now connects to it for the first time.
 */
import { describe, expect, test } from 'bun:test';
import type { Document, Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import { createConflictLifecycleSeedExtension } from './conflict-lifecycle-seed.ts';
import type { ConflictEntry } from './conflict-storage.ts';
import type { SyncEngine } from './sync-engine.ts';

type AfterLoadDocumentHook = NonNullable<Extension['afterLoadDocument']>;
type AfterLoadDocumentPayload = Parameters<AfterLoadDocumentHook>[0];

/** Real `Y.Doc` — the extension writes to `doc.getMap('lifecycle')`, so the
 *  test substrate uses the same Y.Doc the production hook sees. */
function makeDoc(): Y.Doc {
  return new Y.Doc();
}

function makePayload(documentName: string, doc: Y.Doc): AfterLoadDocumentPayload {
  // Cast through `unknown` because Hocuspocus's payload requires properties
  // (instance, requestHeaders, etc.) the extension under test never reads.
  // The runtime contract is that these are present; the unit-tier shape is
  // narrower by design.
  return {
    document: doc as unknown as Document,
    documentName,
  } as unknown as AfterLoadDocumentPayload;
}

function makeEngine(conflicts: ConflictEntry[]): SyncEngine {
  return { getConflicts: () => conflicts } as unknown as SyncEngine;
}

const PROJECT_DIR = '/tmp/ok-conflict-seed-test/project';
const CONTENT_DIR = PROJECT_DIR;

describe('createConflictLifecycleSeedExtension — afterLoadDocument', () => {
  test('sets lifecycle.status="conflict" for a .md doc tracked in ConflictStore', async () => {
    const doc = makeDoc();
    const engine = makeEngine([{ file: 'notes/foo.md', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('notes/foo', doc));

    const lifecycle = doc.getMap('lifecycle');
    expect(lifecycle.get('status')).toBe('conflict');
    expect(lifecycle.get('reason')).toBe('conflict-markers');
  });

  test('sets lifecycle.status="conflict" for a .mdx doc tracked in ConflictStore', async () => {
    const doc = makeDoc();
    const engine = makeEngine([{ file: 'docs/page.mdx', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('docs/page', doc));

    const lifecycle = doc.getMap('lifecycle');
    expect(lifecycle.get('status')).toBe('conflict');
    expect(lifecycle.get('reason')).toBe('conflict-markers');
  });

  test('leaves lifecycle unset when no conflicts are tracked', async () => {
    const doc = makeDoc();
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => makeEngine([]),
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('notes/foo', doc));

    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('leaves lifecycle unset when this docs file is not in the conflicts list', async () => {
    const doc = makeDoc();
    const engine = makeEngine([{ file: 'other.md', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('notes/foo', doc));

    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('short-circuits when SyncEngine is null (dormant / no remote)', async () => {
    const doc = makeDoc();
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => null,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('notes/foo', doc));

    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('idempotent — does not rewrite when lifecycle.status is already "conflict"', async () => {
    const doc = makeDoc();
    // Pre-seed lifecycle as if a sibling path (boot restore / case "conflict")
    // had already set it. The extension must not touch the map again.
    const lifecycle = doc.getMap('lifecycle');
    lifecycle.set('status', 'conflict');
    lifecycle.set('reason', 'merged-with-markers');

    const engine = makeEngine([{ file: 'notes/foo.md', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('notes/foo', doc));

    // Reason stays at the pre-existing value — the extension does not
    // overwrite when status is already "conflict".
    expect(lifecycle.get('status')).toBe('conflict');
    expect(lifecycle.get('reason')).toBe('merged-with-markers');
  });

  test('skips synthetic docs (__system__)', async () => {
    const doc = makeDoc();
    const engine = makeEngine([{ file: '__system__.md', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('__system__', doc));

    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('skips synthetic docs (__config__/project)', async () => {
    const doc = makeDoc();
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => makeEngine([]),
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await ext.afterLoadDocument?.(makePayload('__config__/project', doc));

    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('does not throw when SyncEngine getter throws (failure isolation)', async () => {
    const doc = makeDoc();
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => {
        throw new Error('sync engine probe failed');
      },
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    // The async hook must not propagate — Hocuspocus's afterLoadDocument
    // chain rejects close the WebSocket via the outer ResetConnection path.
    await expect(ext.afterLoadDocument?.(makePayload('notes/foo', doc))).resolves.toBeUndefined();
    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('does not throw when engine.getConflicts() throws (failure isolation)', async () => {
    // Distinct from the prior test: the engine reference is non-null but the
    // ConflictStore call itself fails (e.g., corrupted conflicts.json during
    // lazy init). The catch block covers both failure modes; this is the
    // regression pin against any future narrowing of the try/catch scope.
    const doc = makeDoc();
    const brokenEngine = {
      getConflicts: () => {
        throw new Error('conflict store load failed');
      },
    } as unknown as SyncEngine;
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => brokenEngine,
      projectDir: PROJECT_DIR,
      contentDir: CONTENT_DIR,
    });

    await expect(ext.afterLoadDocument?.(makePayload('notes/foo', doc))).resolves.toBeUndefined();
    expect(doc.getMap('lifecycle').get('status')).toBeUndefined();
  });

  test('handles projectDir-relative ConflictEntry.file with nested contentDir', async () => {
    const doc = makeDoc();
    // SyncEngine tracks files project-relative; if contentDir is `content/`
    // under projectDir, entry.file = `content/foo.md` must still map to
    // docName `foo` correctly.
    const engine = makeEngine([{ file: 'content/foo.md', detectedAt: '2026-05-22T00:00:00.000Z' }]);
    const ext = createConflictLifecycleSeedExtension({
      getSyncEngine: () => engine,
      projectDir: PROJECT_DIR,
      contentDir: `${PROJECT_DIR}/content`,
    });

    await ext.afterLoadDocument?.(makePayload('foo', doc));

    expect(doc.getMap('lifecycle').get('status')).toBe('conflict');
  });
});
