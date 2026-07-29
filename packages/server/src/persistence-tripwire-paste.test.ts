/**
 * The persistence structural-duplication tripwire against a legitimate
 * whole-document paste, on the REAL `onStoreDocument` path.
 *
 * The measured failure: a user hand-types blank-line-separated paragraphs,
 * selects all, copies, pastes. The candidate body is now an exact doubling of
 * the base, so `classifyDuplication` returns `block` — the same verdict the
 * stale-cache merge produces. The tripwire then refuses the disk write AND
 * resets the live Y.Doc from disk under `FILE_WATCHER_ORIGIN`, which is not
 * undo-eligible on either side, so the paste is destroyed silently.
 *
 * The two classes are byte-identical at the classifier: both arrive under a
 * browser `source: 'connection'` origin and both duplicate with agreeing node
 * shapes, so neither transaction origin nor the Observer-A provenance/shape
 * test separates them. What does separate them is WHEN the doubling appears.
 * The stale-cache merge materializes at provider-sync time, before the session
 * has produced a settled write; a paste is an incremental edit on a document
 * that has already persisted cleanly. The tripwire therefore only acts
 * destructively while the document has no settled write behind it, and
 * checkpoints the live content before it does.
 *
 * Fidelity: real `createServer`, real `onStoreDocument`, real on-disk
 * contentDir, real Hocuspocus debounce, real shadow repo. The only test
 * affordance is `debounce`/`maxDebounce`, real `ServerOptions` fields the
 * sibling tripwire tests already use.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { lossCaptureCurrentPath, parseLossCaptureLines } from './loss-capture.ts';
import { mdManager, schema } from './md-manager.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { createServer } from './server-factory.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, 'persistence-tripwire.fixtures');

/**
 * The reported document as it lands on disk. WYSIWYG Enter-Enter leaves an
 * EMPTY paragraph node between each typed paragraph, which serializes as a
 * doubled blank line — that is what makes this 51 bytes rather than the 43
 * the same five paragraphs occupy with single blank lines.
 */
const USER_DOC = 'hello\n\n\n\nkjnekandkjawnkjd\n\n\n\nwkajnd\n\n\n\nwk\n\n\n\nwwjwj\n';
const USER_DOC_LINE = 'kjnekandkjawnkjd';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test-paste' } },
} as const;

const P = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const EMPTY = { type: 'paragraph' };

/** The nine children Enter-Enter typing of USER_DOC produces. */
const TYPED_CHILDREN = [
  P('hello'),
  EMPTY,
  P(USER_DOC_LINE),
  EMPTY,
  P('wkajnd'),
  EMPTY,
  P('wk'),
  EMPTY,
  P('wwjwj'),
];

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function expectStable<T>(
  read: () => T,
  { durationMs = 700, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<T> {
  const initial = read();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (read() !== initial) throw new Error('value changed during stability window');
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return initial;
}

interface Rig {
  tmpDir: string;
  shadow: ShadowHandle;
  cleanup: () => void;
}

async function setupRig(prefix: string): Promise<Rig> {
  // Realpath first: on macOS the tmpdir is a symlink, and persistence derives
  // its shadow tree prefix from `relative(projectDir, contentDir)` — two
  // spellings of the same directory resolve that to an escaping absolute path.
  const tmpDir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  // Pin the branch rather than inheriting `init.defaultBranch`. Checkpoint refs
  // are namespaced `refs/checkpoints/<branch>` off the real repo HEAD, so a
  // machine defaulting to `master` files the anchor somewhere this test would
  // otherwise not look.
  await git.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  const shadow = await initShadowRepo(tmpDir);
  return {
    tmpDir,
    shadow,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function replaceFragment(doc: Y.Doc, content: unknown[]): void {
  const xmlFragment = doc.getXmlFragment('default');
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, schema.nodeFromJSON({ type: 'doc', content }), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, BROWSER_ORIGIN);
}

/** The live fragment's children, as the clipboard would carry them. */
function liveChildren(frag: Y.XmlFragment): unknown[] {
  const json = yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON() as {
    content?: unknown[];
  };
  return json.content ?? [];
}

function blockedEvents(warnSpy: { mock: { calls: unknown[][] } }): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((s) => s.includes('"event":"ok-persistence-duplication-blocked"'));
}

describe('persistence tripwire vs a whole-document paste', () => {
  let rig: Rig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('the classifier still reads a whole-document double as a block verdict', () => {
    // The discriminator lives at the tripwire call site, not in the classifier:
    // the shape genuinely IS an integer doubling, and the epoch-recovery guard
    // still needs that verdict. Pinning it here keeps a future "fix" from
    // weakening the classifier instead of the action it drives.
    expect(USER_DOC.length).toBe(51);
    expect(classifyDuplication(`${USER_DOC}\n${USER_DOC}`, USER_DOC)).toEqual({
      kind: 'block',
      reason: 'structural-duplication',
      copies: 2,
    });
  });

  test('select-all copy paste after a settled write survives and reaches disk', async () => {
    rig = await setupRig('ok-tripwire-paste-');
    const docName = 'Untitled';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      const frag = serverDoc.getXmlFragment('default');

      // The user hand-types five blank-line-separated paragraphs, and that
      // typing settles to disk as one clean copy. This settled write is what
      // marks the session as user-driven.
      replaceFragment(serverDoc, TYPED_CHILDREN);
      await waitFor(() => readFileSync(docPath, 'utf-8').length > 0);
      const baseline = readFileSync(docPath, 'utf-8');
      expect(baseline).toBe(USER_DOC);

      // Select all, copy, paste. Derived from the LIVE fragment, so this is
      // byte-for-byte what the user's own clipboard held.
      const kids = liveChildren(frag);
      replaceFragment(serverDoc, [...kids, ...kids]);
      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);

      // The paste must reach disk rather than being refused as corruption.
      await waitFor(() => readFileSync(docPath, 'utf-8') !== baseline);
      const persisted = await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(occurrences(persisted, USER_DOC_LINE)).toBe(2);
      expect(persisted.length).toBeGreaterThan(baseline.length);

      // And the live document must still hold it — the destructive half of the
      // tripwire is what actually took the content away from the user.
      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);
      expect(frag.length).toBeGreaterThan(TYPED_CHILDREN.length);

      // No block fired, so no checkpoint was needed and nothing was reset.
      expect(blockedEvents(warnSpy)).toHaveLength(0);
      expect(getMetrics().persistenceDuplicationReset).toBe(0);
      expect(getMetrics().persistenceDuplicationSpared).toBe(1);

      // The spared breadcrumb carries bounded-cardinality keys only. Pinning the
      // key SET, not just the values, is what stops a later change from adding a
      // raw-content field to an event that ships to telemetry.
      const spared = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-spared"'));
      expect(spared).toHaveLength(1);
      const sparedPayload = JSON.parse(spared[0] ?? '{}') as Record<string, unknown>;
      expect(new Set(Object.keys(sparedPayload))).toEqual(
        new Set([
          'event',
          'doc.name',
          'candidateBytes',
          'baseBytes',
          'fragmentChildren',
          'copies',
          'reason',
        ]),
      );
      expect(sparedPayload['doc.name']).toBe(docName);
      expect(sparedPayload.copies).toBe(2);

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('a doubling with no settled write behind it still blocks, resets, and checkpoints', async () => {
    // The incident shape: the document loads from disk and is immediately
    // mutated to the doubled candidate, with no settled write in between. The
    // guard must still act — and the content it destroys must now be
    // recoverable from a checkpoint of its own kind.
    rig = await setupRig('ok-tripwire-incident-');
    const docName = 'incident-changeset-readme';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');
    const baselineBytes = readFileSync(docPath, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const baseChildren = serverDoc.getXmlFragment('default').length;
      expect(baseChildren).toBeGreaterThan(0);

      const doubledJson = mdManager.parseWithFallback(doubledMarkdown) as { content?: unknown[] };
      replaceFragment(serverDoc, doubledJson.content ?? []);
      expect(serverDoc.getXmlFragment('default').length).toBe(baseChildren * 2);

      await waitFor(() => blockedEvents(warnSpy).length > 0);

      // Disk untouched, live document reset to the disk canonical state.
      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(baselineBytes);
      await waitFor(() => serverDoc.getXmlFragment('default').length === baseChildren);
      await waitFor(() => serverDoc.getText('source').toString() === baselineBytes);
      expect(getMetrics().persistenceDuplicationReset).toBe(1);

      // The reset destroys live content, so it owes a restore anchor. Gate on
      // the completion counter: git creates the ref before the write promise
      // settles, so polling refs alone can observe a half-finished mint.
      await waitFor(() => getMetrics().persistenceDuplicationResetCheckpointCreated >= 1, {
        timeoutMs: 10_000,
      });
      // Listed across every branch namespace, not just `refs/checkpoints/main`,
      // so the assertion pins "exactly one anchor was minted" rather than
      // "an anchor landed on the branch this test happened to guess".
      const shas = (
        await shadowGit(rig.shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints',
        )
      )
        .toString()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(shas).toHaveLength(1);
      const sha = shas[0] ?? '';

      // End to end: the anchor's blob holds the doubled content the reset took
      // away, and it surfaces as an ordinary restorable timeline row.
      const blob = (await shadowGit(rig.shadow).raw('show', `${sha}:${docName}`)).toString();
      expect(occurrences(blob, 'changeset')).toBeGreaterThan(
        occurrences(baselineBytes, 'changeset'),
      );
      const hist = await getDocumentHistory(rig.shadow, { docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.kind).toBe('persistence-duplication-reset');
      expect(row?.checkpoint?.metadata).toEqual({ copies: 2, fragmentChildren: baseChildren * 2 });

      // The reset threads `detect` into the paired intake, which is the whole
      // reason the injectable seam had to widen. Without a ring event here the
      // widening buys nothing, so pin the detector trip and its anchor.
      const ring = parseLossCaptureLines(
        readFileSync(lossCaptureCurrentPath(rig.tmpDir), 'utf-8'),
      ).filter((e) => e.site === 'persistence-duplication-reset');
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.docName).toBe(docName);
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThan(0);
      expect(ring.some((e) => e.event === 'checkpoint-write' && e.checkpointSha === sha)).toBe(
        true,
      );

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);
});
