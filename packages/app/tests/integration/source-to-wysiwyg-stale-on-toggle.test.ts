/**
 * Source → WYSIWYG mode switch shows stale content — the booted-server rung.
 *
 * The two editing surfaces are different CRDT types in one Y.Doc, reconciled
 * only by the server: the source editor writes `Y.Text('source')` synchronously
 * per keystroke, while the WYSIWYG surface renders `Y.XmlFragment('default')`,
 * which only the server's Observer B rewrites. The mode toggle
 * (`EditorPane.handleModeChange`) is synchronous and unconditional — it checks
 * nothing about fragment freshness — so it reveals whatever the fragment holds
 * at that instant.
 *
 * Row 1 pins the ordinary window, deterministically, with `pauseSync()` standing
 * in for "the derive round trip has not landed yet".
 *
 * Rows 2-4 pin why this stale state does not clear itself. Two facts
 * compose:
 *
 *  1. Nothing repairs the divergence. Observer B's derive-timing defer guard
 *     suspends the re-derive while the fragment holds an un-propagated WYSIWYG
 *     keystroke, and persistence's `onStoreDocument` divergence gate makes the
 *     SAME `fragmentHoldsPendingContent` call and takes its HOLD arm — leaving
 *     the fragment intact and writing only Y.Text to disk (`persistence.ts`,
 *     the three-arm comment above `recordDeferHold`). Both mechanisms exist to
 *     protect the keystroke from being stomped; together they also mean the
 *     source-mode edit never reaches the surface the user is looking at.
 *  2. Nothing resets the state. The server keeps every content-bearing document
 *     resident for its process lifetime (`server-factory.ts`
 *     `shouldUnloadDocument`), so a client detach and reconnect — which is what
 *     BOTH closing/reopening a document and View → Reload do, from the server's
 *     point of view — re-runs neither `onLoadDocument` nor the observer attach.
 *     The `setupServerObservers` closure and its converged-fragment witness
 *     survive, so the hold predicate keeps returning true.
 *
 * Row 4 is the control: killing the process DOES clear it — which is why
 * quitting and relaunching the desktop app is the only recovery.
 *
 * Note the mechanism this suite ruled OUT. The re-derive backstop freeze
 * (`bDirectionFrozen`) produces the same stale fragment, but persistence's
 * divergence gate does not classify it as a defer hold, so it takes the
 * checkpoint-then-repair arm and the fragment is rebuilt on the next store. A
 * backstop freeze is therefore NOT a candidate for this symptom.
 *
 * Scope: the defer-hold staging needs a node whose `sourceRaw` stamp holds a
 * whole block's raw text (an MDX component), so a document without one cannot
 * reach this shape. The neighbouring cross-mode undo suites pin a different
 * defect with the same user-facing symptom; see §5 of
 * `feature-specs/single-crdt-migration.md` for how the two were told apart.
 *
 * Note for a future fix: the repair primitive already works. A fresh observer
 * closure over a diverged doc reconciles on its next fragment-dirtying drain
 * (pinned in `packages/server/src/derive-latch-stales-wysiwyg.test.ts`). What is
 * missing is a trigger on client re-attach.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitDocQuiescence,
  createRestartableServer,
  createTestClient,
  createTestServer,
  getServerState,
  mdManager,
  pollUntil,
  schema,
  serializeFragment,
  type TestClient,
  type TestServer,
} from './test-harness';

// The server serializes freshness-ON (its md-manager singleton), so a
// component's live children are visible rather than its stale `sourceRaw`. The
// harness `mdManager` is freshness-OFF, so the server-side fragment must be read
// through a matching freshness-ON serialize. Mirrors
// `derive-timing-guard-full-flow.test.ts`.
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const freshSchema = getSchema(sharedExtensions);

function freshSerializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(fragment, freshSchema).toJSON(),
  );
}

/** Rewrite the first text leaf equal to `from` into `to`, in place. */
function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

// A faithful `<Steps>` whose component children can be advanced past the stamped
// `sourceRaw` — the staging surface the derive-timing guard is defined over.
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** The line a user types in source mode and then expects to see in the WYSIWYG. */
const SENTINEL = 'TOGGLE-SENTINEL typed in source mode';

/**
 * Detach a client the way closing a tab or reloading the renderer does: drop the
 * WebSocket and the client-side Y.Doc, and leave the SERVER's document alone.
 *
 * Deliberately NOT `client.cleanup()`. That helper posts `/api/test-reset`,
 * which calls `forceUnloadDocument` and truncates the file — the one thing
 * production close/reload never does, and precisely the state reset these rows
 * exist to prove does not happen.
 */
function detachClientKeepingServerDoc(client: TestClient): void {
  client.provider.destroy();
  client.doc.destroy();
}

/**
 * Create + load a doc through the real agent-write spine, then leave the
 * fragment holding an un-propagated WYSIWYG keystroke while Y.Text carries a
 * later source-mode edit — the shape Observer B's defer guard suspends and
 * persistence's matching hold arm declines to repair.
 *
 * Mirrors the staging in `derive-timing-guard-full-flow.test.ts`. Fakes `Date`
 * to drive the server's freshness-quiescence window; the caller is responsible
 * for restoring real timers.
 */
async function stageDeferHeldDivergence(port: number, docName: string, doc: Y.Doc): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
  });
  expect(res.status).toBe(200);

  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');
  expect(ytext.toString()).toContain(STALE_LINE);

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);

  // Poke Y.Text to reset the freshness-quiescence clock, then advance the
  // component's children past its stamped `sourceRaw` inside that window, so
  // Observer A settles with stale witnesses and the fragment ends up ahead.
  doc.transact(() => {
    ytext.insert(ytext.length, '\nTrailing.\n');
  }, 'external-peer');
  const echo = mdManager.parse(ytext.toString()) as JSONContent;
  expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
  doc.transact(() => {
    updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, 'wysiwyg-echo');

  // The source-mode edit the user makes and then expects to see in the WYSIWYG.
  doc.transact(() => {
    ytext.insert(ytext.length, `\n${SENTINEL}\n`);
  }, 'external-peer');
}

describe('source → WYSIWYG toggle shows stale content', () => {
  test(
    'a defer-held stale fragment survives a detach and reconnect',
    async () => {
      // Its own server: this row fakes `Date` to drive the server's freshness
      // window, which must not leak into the shared-server rows.
      const ownServer = await createTestServer();
      const docName = `stale-toggle-reopen-${crypto.randomUUID().slice(0, 8)}`;
      let reopened: TestClient | undefined;
      try {
        // The agent-write spine loads the doc, so read it back after the call.
        await fetch(`http://127.0.0.1:${ownServer.port}/api/agent-write-md`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
        });
        const doc = ownServer.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
        expect(doc).toBeTruthy();

        await stageDeferHeldDivergence(ownServer.port, docName, doc);
        vi.useRealTimers();

        // Observer B deferred rather than re-derive, so the server's own
        // fragment does not carry the source edit.
        expect(doc.getText('source').toString()).toContain(SENTINEL);
        expect(freshSerializeFragment(doc.getXmlFragment('default'))).not.toContain(SENTINEL);

        // A client attaching now sees the divergence: source correct, WYSIWYG
        // stale. This is the mode switch showing the wrong document.
        reopened = await createTestClient(ownServer.port, docName, {
          skipInvariantWatcher: true,
        });
        await awaitDocQuiescence(reopened.doc);
        expect(reopened.ytext.toString()).toContain(SENTINEL);
        expect(serializeFragment(reopened.fragment)).not.toContain(SENTINEL);

        // ── Close the document / reload the renderer, then reopen.
        //
        // No connection-count gate here: this doc was created through the
        // agent-write spine, which holds its own direct connection for the
        // document's lifetime, so the count never reaches zero. The editor
        // client's detach is what this row models, and row 2 pins the
        // zero-client disconnect semantics on a doc without an agent session.
        detachClientKeepingServerDoc(reopened);
        reopened = undefined;

        // The server still holds the document — and its latched observer
        // closure — so nothing re-derived in the interval.
        expect(getServerState(ownServer, docName)).not.toBeNull();

        // Reopen. The harness client attaches no IndexedDB persistence, so this
        // is a cache-free reader: anything stale it sees came from the server.
        reopened = await createTestClient(ownServer.port, docName, {
          skipInvariantWatcher: true,
        });
        await awaitDocQuiescence(reopened.doc);

        // The stale WYSIWYG surviving a reopen — the property this suite pins.
        expect(reopened.ytext.toString()).toContain(SENTINEL);
        expect(serializeFragment(reopened.fragment)).not.toContain(SENTINEL);
      } finally {
        vi.useRealTimers();
        if (reopened) {
          reopened.provider.destroy();
          reopened.doc.destroy();
        }
        await ownServer.cleanup();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'control: restarting the server does clear it',
    async () => {
      // The falsifiability control. Killing the process is the one action that drops the
      // resident document, so the doc reloads from disk — where Y.Text's bytes
      // (which the persistence hold arm still wrote) are correct — and derives a
      // fresh fragment through a fresh observer closure.
      //
      // If this row ever fails, the latch is not where this suite says it is.
      let restartable = await createRestartableServer();
      const docName = `stale-toggle-restart-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await fetch(`http://127.0.0.1:${restartable.port}/api/agent-write-md`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
        });
        const doc = restartable.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
        expect(doc).toBeTruthy();

        await stageDeferHeldDivergence(restartable.port, docName, doc);
        vi.useRealTimers();

        // Diverged before the restart, same as the row above.
        expect(doc.getText('source').toString()).toContain(SENTINEL);
        expect(freshSerializeFragment(doc.getXmlFragment('default'))).not.toContain(SENTINEL);

        // The hold arm still writes Y.Text to disk — durability is never what
        // the defer suspends. Wait for those bytes to land before the restart.
        const filePath = join(restartable.contentDir, `${docName}.md`);
        await pollUntil(
          () => existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(SENTINEL),
          10_000,
        );

        restartable = await restartable.killAndRestartOnSamePort({ downtimeMs: 200 });

        // Reopen against the restarted server. The doc reloads from disk with an
        // empty fragment and derives fresh — the WYSIWYG now matches source.
        const after = await createTestClient(restartable.port, docName, {
          skipInvariantWatcher: true,
        });
        try {
          await pollUntil(() => serializeFragment(after.fragment).includes(SENTINEL), 10_000);
          expect(after.ytext.toString()).toContain(SENTINEL);
          expect(serializeFragment(after.fragment)).toContain(SENTINEL);
        } finally {
          after.provider.destroy();
          after.doc.destroy();
        }
      } finally {
        vi.useRealTimers();
        await restartable.shutdown();
      }
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
