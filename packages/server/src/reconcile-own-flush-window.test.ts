/**
 * Own-write discrimination for `reconcileDiskBeforeAgentWrite`.
 *
 * Invariant under test: an agent write must NOT be refused (409) or latch a
 * doc into lifecycle `conflict` because of the server's OWN persistence
 * activity. The store hook's commit sequence is non-atomic with respect to
 * concurrent readers (TOCTOU — the producer cannot make FS rename + base
 * advance atomic):
 *
 *   tracedWriteFile(tmp)  → tracedRename(tmp, canonical)   disk = NEW bytes
 *   ── window: disk is new; reconciledBase is still stale ──
 *   onDiskFlush(...)                                        ← existing hook,
 *   setReconciledBase(doc, markdown)                          fires in-window
 *
 * A guard read inside that window sees disk == the server's own just-flushed
 * bytes while `getReconciledBase` is still the PREVIOUS flush's content.
 * The guard's predicate "disk ≠ base ⟹ a foreign process edited the file"
 * does not hold there: the divergence is phantom, the three-way
 * `reconcile(base=stale, ours=live Y.Text, theirs=own flush snapshot)`
 * classifies the overlapping tail as `conflicts`, the doc is latched into
 * lifecycle `conflict`, and the agent write is refused through the uniform
 * `DocInConflictError` gate — with no clearing path (the file watcher drops
 * the own-write event via `isSelfWrite`), so every later agent write 409s.
 *
 * Determinism: the tests reach the window through the EXISTING production
 * `onDiskFlush` persistence hook (fires after the atomic rename, before the
 * base advances) rather than racing real debounce timing — a real in-flight
 * flush of the real persistence extension against a real disk file, hit on
 * every run. `isDocInConflict` is asserted because it is the exact predicate
 * every mutating write surface uses to throw `DocInConflictError` (HTTP 409).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { isDocInConflict } from './conflict-errors.ts';
import {
  type ReconcileBeforeWriteResult,
  reconcileDiskBeforeAgentWrite,
} from './external-change.ts';
import {
  createPersistenceExtension,
  getReconciledBase,
  peekInFlightFlush,
  setBatchInProgress,
  switchReconciledBaseScope,
} from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

/**
 * Mutates BOTH the XmlFragment and Y.Text under the caller's transaction so
 * the Y.Text-is-truth contract sees consistent state (same helper shape as
 * persistence-deferred-store.test.ts — no observer bridge wired here).
 */
function replaceDocParagraphs(document: Y.Doc, texts: string[]): void {
  const body = `${texts.join('\n\n')}\n`;
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  fragment.insert(
    0,
    texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  if (ytext.length > 0) {
    ytext.delete(0, ytext.length);
  }
  ytext.insert(0, body);
}

async function loadDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onLoadDocument?.({
    document,
    documentName,
    context: {},
  } as never);
}

async function storeDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onStoreDocument?.({
    document,
    documentName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  } as never);
}

/** Minimal Hocuspocus shape the guard consults (`hocuspocus.documents.get`). */
function fakeHocuspocusWith(docName: string, document: Y.Doc): Hocuspocus {
  return { documents: new Map([[docName, document]]) } as unknown as Hocuspocus;
}

const BASE_CONTENT = 'alpha\n\nbeta\n'; // prior flush (stale base in-window)
const FLUSHED_PARAGRAPHS = ['alpha', 'beta gamma']; // own flush snapshot (theirs)
const FLUSHED_CONTENT = 'alpha\n\nbeta gamma\n';
const LIVE_PARAGRAPHS = ['alpha', 'beta gamma delta']; // live Y.Text moved past the snapshot (ours)

interface WindowProbe {
  windowResult: ReconcileBeforeWriteResult | undefined;
  baseSeenInWindow: string | undefined;
  inFlightSeenInWindow: string | undefined;
  conflictAfterGuard: boolean | undefined;
}

/**
 * Drives the phantom-divergence sequence once:
 *   1. disk + base start at BASE_CONTENT (prior flush settled),
 *   2. doc edits to FLUSHED_CONTENT, a real store flushes it,
 *   3. inside the flush-commit window (onDiskFlush: rename landed, base still
 *      stale) the live doc moves past the snapshot (LIVE_PARAGRAPHS) and an
 *      agent write's guard runs — exactly the production interleaving.
 * Returns the in-window observations; the store promise has fully settled
 * (base advanced to FLUSHED_CONTENT) by the time this resolves.
 */
async function drivePhantomDivergence(
  tmpDir: string,
  docName: string,
  document: Y.Doc,
  options: { diskContentInWindow?: string } = {},
): Promise<WindowProbe> {
  const docPath = join(tmpDir, `${docName}.md`);
  writeFileSync(docPath, BASE_CONTENT, 'utf-8');

  const probe: WindowProbe = {
    windowResult: undefined,
    baseSeenInWindow: undefined,
    inFlightSeenInWindow: undefined,
    conflictAfterGuard: undefined,
  };

  let windowFired = false;
  const persistence = createPersistenceExtension({
    contentDir: tmpDir,
    projectDir: tmpDir,
    gitEnabled: false,
    onDiskFlush: (name) => {
      if (name !== docName || windowFired) return;
      windowFired = true;
      // Live doc moves past the flush snapshot while the commit is mid-flight
      // (in production: further agent/user edits landing during the flush).
      document.transact(() => replaceDocParagraphs(document, LIVE_PARAGRAPHS), BROWSER_ORIGIN);
      probe.baseSeenInWindow = getReconciledBase(docName);
      // Pins set-before-window ordering: the signal must already be set when
      // a guard read can first observe the renamed bytes. Without this, a
      // reorder moving the set after the rename would silently disable the
      // own-flush discrimination while the suite stays green.
      probe.inFlightSeenInWindow = peekInFlightFlush(docName);
      // A FOREIGN writer landing inside the same window (bytes ≠ the
      // in-flight snapshot).
      if (options.diskContentInWindow !== undefined) {
        writeFileSync(docPath, options.diskContentInWindow, 'utf-8');
      }
      // The agent write's guard reads disk inside the server's own
      // flush-commit window — the production race, hit deterministically.
      probe.windowResult = reconcileDiskBeforeAgentWrite(
        fakeHocuspocusWith(docName, document),
        docName,
        tmpDir,
      );
      probe.conflictAfterGuard = isDocInConflict(document as never);
    },
  });

  await loadDocument(persistence, document, docName);
  document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);
  await storeDocument(persistence, document, docName);

  expect(windowFired).toBe(true);
  // Window preconditions actually held when the guard ran: the base was still
  // the PREVIOUS flush's content while disk already carried the own flush.
  expect(probe.baseSeenInWindow).toBe(BASE_CONTENT);
  return probe;
}

describe('reconcileDiskBeforeAgentWrite — own persistence flush is not foreign divergence', () => {
  let tmpDir: string;
  let document: Y.Doc;

  beforeEach(() => {
    // realpathSync: macOS /var → /private/var; without it the guard's
    // isWithinContentDir symlink-escape check would skip the read entirely
    // and the test would pass vacuously.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-own-flush-window-')));
    mkdirSync(tmpDir, { recursive: true });
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    document = new Y.Doc();
  });

  afterEach(() => {
    document.destroy();
    setBatchInProgress(false);
    switchReconciledBaseScope('main');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("an agent write inside the server's own flush-commit window is not refused and does not latch lifecycle conflict", async () => {
    const docName = 'own-flush-window';
    const probe = await drivePhantomDivergence(tmpDir, docName, document);

    // The disk bytes the guard read were the server's OWN in-flight flush —
    // not an out-of-band edit. Latching `lifecycle.status = 'conflict'` here
    // makes the caller's mutating write throw DocInConflictError (HTTP 409)
    // for the server's own persistence activity.
    expect(probe.conflictAfterGuard).toBe(false);
    expect(isDocInConflict(document as never)).toBe(false);
    // And nothing foreign was ingested: the guard must treat its own flush
    // bytes as not-diverged.
    expect(probe.windowResult?.reconciled).toBe(false);
    // The signal was actually SET when the guard ran in-window — pins the
    // set-before-rename ordering so the fault test's "undefined after a
    // faulted store" assertion can't pass vacuously via a never-set signal.
    expect(probe.inFlightSeenInWindow).toBe(normalizeBridge(FLUSHED_CONTENT));
  });

  test('a FOREIGN disk edit landing inside the flush window still reconciles (narrow-equality safety boundary)', async () => {
    const docName = 'own-flush-foreign-in-window';
    // Foreign bytes differ from the in-flight snapshot (which edits the beta
    // paragraph) by editing the alpha paragraph instead — so the three-way
    // merge against ours (LIVE_PARAGRAPHS, beta edit) resolves cleanly and
    // `reconciled === true` is deterministic. If the discriminator is ever
    // loosened (presence-only check, prefix match, over-aggressive
    // normalization), the foreign edit is misclassified as own-write, the
    // guard skips, and this test fails on reconciled === false.
    const FOREIGN_CONTENT = 'alpha FOREIGN EDIT\n\nbeta\n';
    const probe = await drivePhantomDivergence(tmpDir, docName, document, {
      diskContentInWindow: FOREIGN_CONTENT,
    });

    // The in-flight signal WAS set when the guard ran…
    expect(probe.inFlightSeenInWindow).toBe(normalizeBridge(FLUSHED_CONTENT));
    // …yet the foreign bytes must NOT match it: the guard falls through to
    // the three-way merge instead of silently dropping the out-of-band edit.
    expect(probe.windowResult?.reconciled).toBe(true);
    // It MUST be a three-way merge, not an accept-theirs 'clean': the foreign
    // edit touched a different block than the un-flushed live edits, so 'clean'
    // (wholesale accept-theirs) would silently drop those live edits.
    expect(probe.windowResult?.mergeOutcome).toBe('merged');
  });

  test('no permanent 409 wedge: after the flush settles, subsequent agent writes are not refused', async () => {
    const docName = 'own-flush-wedge';
    await drivePhantomDivergence(tmpDir, docName, document);

    // The flush has fully committed: disk == base == the flushed bytes; the
    // only possible residue of the phantom divergence is the lifecycle latch.
    expect(getReconciledBase(docName)).toBe(FLUSHED_CONTENT);

    // A later agent write runs the same guard first…
    const laterGuard = reconcileDiskBeforeAgentWrite(
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );
    expect(laterGuard.reconciled).toBe(false);

    // …and then the uniform write gate. `isDocInConflict` is the exact
    // predicate every mutating write surface (agent-sessions.ts,
    // api-extension.ts) uses to throw DocInConflictError → HTTP 409. The
    // file watcher drops the server's own-write event via isSelfWrite, so no
    // watcher event exists to clear a latch set on an own flush — if the
    // latch is set, the doc is wedged: every subsequent agent write 409s
    // forever with no recovery path.
    expect(isDocInConflict(document as never)).toBe(false);
  });

  test('a failed disk flush does not leave the in-flight flush signal stuck set', async () => {
    const docName = 'own-flush-fault';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, BASE_CONTENT, 'utf-8');

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
    });
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);

    const prevFault = process.env.OK_TEST_STORE_FAULT;
    process.env.OK_TEST_STORE_FAULT = docName;
    try {
      await expect(storeDocument(persistence, document, docName)).rejects.toThrow(
        'OK_TEST_STORE_FAULT',
      );
    } finally {
      if (prevFault === undefined) {
        delete process.env.OK_TEST_STORE_FAULT;
      } else {
        process.env.OK_TEST_STORE_FAULT = prevFault;
      }
    }

    // A stuck signal would make the guard treat any FUTURE foreign disk edit
    // that happens to match the failed flush's bytes as the server's own.
    expect(peekInFlightFlush(docName)).toBeUndefined();
    // Symmetric invariant: the base must NOT have advanced to the never-landed
    // flush. setReconciledBase runs only after a successful rename, so the
    // faulted store leaves the base at the last good content. A spuriously
    // advanced base would make the next real disk edit look in-sync and skip
    // reconcile.
    expect(getReconciledBase(docName)).toBe(BASE_CONTENT);
  });

  test("an earlier overlapping flush settling does not clear a later flush's in-flight signal", async () => {
    const docName = 'own-flush-overlap';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, BASE_CONTENT, 'utf-8');

    const OVERLAP_PARAGRAPHS = ['alpha', 'beta gamma epsilon'];
    const OVERLAP_CONTENT = 'alpha\n\nbeta gamma epsilon\n';

    let windowFired = false;
    let laterFlush: Promise<void> | undefined;
    let peekAfterLaterStart: string | undefined;
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      onDiskFlush: (name) => {
        if (name !== docName || windowFired) return;
        windowFired = true;
        // Inside flush A's commit window, start flush B with different
        // content. B's in-flight set runs synchronously (no awaits precede
        // it in storeDocumentNow), overwriting A's entry.
        document.transact(() => replaceDocParagraphs(document, OVERLAP_PARAGRAPHS), BROWSER_ORIGIN);
        laterFlush = storeDocument(persistence, document, docName);
        peekAfterLaterStart = peekInFlightFlush(docName);
      },
    });

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);
    await storeDocument(persistence, document, docName);

    expect(windowFired).toBe(true);
    // B overwrote A's entry while A was still mid-commit…
    expect(peekAfterLaterStart).toBe(normalizeBridge(OVERLAP_CONTENT));
    // …and A's settle (its .finally ran before its store promise resolved)
    // must NOT have cleared B's still-live signal: the clear is guarded on
    // the entry still being A's own. Dropping that guard in a "simplify"
    // refactor reintroduces the unguarded-window wedge this suite pins.
    expect(peekInFlightFlush(docName)).toBe(normalizeBridge(OVERLAP_CONTENT));

    await laterFlush;
    // B's own settle clears its entry — no stuck signal.
    expect(peekInFlightFlush(docName)).toBeUndefined();
  });
});
