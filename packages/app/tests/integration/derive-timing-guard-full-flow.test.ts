/**
 * Full-flow coverage for the derive-timing defer guard: the guard is wired
 * through the REAL boot path — `.ok/config.yml` (`bridge.deferGuard.enabled`,
 * default ON) → `createServer` → the observer extension → `setupServerObservers`
 * — and preserves an un-propagated WYSIWYG keystroke on a booted server.
 *
 * The un-propagated window is staged on the booted server's own Y.Doc: a
 * freshness-suppressed Observer A settlement leaves the fragment holding a
 * component's advanced children while Y.Text lags a generation, and a
 * source-editor write over the live WS then drives an Observer B re-derive that
 * would stomp it without the guard. The server runs in-process, so faking `Date`
 * drives its freshness-quiescence window deterministically; only `Date` is
 * faked, so the real WS + async I/O proceed normally.
 *
 * The byte-corruption itself only manifests under real cross-peer concurrency
 * (the browser canaries own that rung); this pins that the guard is LIVE end to
 * end and survives the drain-shaped re-derive on the real server.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, getServerState, mdManager, type TestServer } from './test-harness.ts';

const schema = getSchema(sharedExtensions);
// The server serializes freshness-ON (its md-manager singleton), so the guard
// sees a component's advanced children. The harness `mdManager` is freshness-OFF
// (reads the stale sourceRaw), so verify the fragment's live children with a
// matching freshness-ON serialize.
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';

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

/** Freshness-ON serialize — sees a component's live children, not stale sourceRaw. */
function serializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

/** A fresh contentDir whose `.ok/config.yml` switches the defer guard off. */
function guardDisabledContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-defer-guard-off-'));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), 'bridge:\n  deferGuard:\n    enabled: false\n');
  writeFileSync(join(dir, 'test-doc.md'), '', 'utf-8');
  return dir;
}

describe('derive-timing guard — full-flow on a booted server', () => {
  let server: TestServer;
  let ownedContentDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await server.cleanup();
    if (ownedContentDir) rmSync(ownedContentDir, { recursive: true, force: true });
    ownedContentDir = undefined;
  });

  test(
    'the config-wired guard preserves an un-propagated keystroke on the real server',
    async () => {
      server = await createTestServer();
      const docName = `defer-full-${crypto.randomUUID().slice(0, 8)}`;
      // Create + load the doc at GEN1 through the real agent-write spine (paired),
      // so the observers attach with the config-resolved guard + loss ring.
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
      });
      expect(res.status).toBe(200);

      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      expect(doc).toBeTruthy();
      const state = getServerState(server, docName);
      expect(state?.ytext.toString()).toContain(STALE_LINE);
      const ytext = state?.ytext as Y.Text;
      const fragment = state?.fragment as Y.XmlFragment;

      // Drive the server's freshness clock deterministically from here.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000); // quiescent baseline

      // Poke Y.Text to reset the freshness-quiescence clock.
      doc.transact(() => {
        ytext.insert(ytext.length, '\nTrailing.\n');
      }, 'external-peer');

      // Echo drain INSIDE the window: advance the component children to the
      // pending line while sourceRaw stays stale → Observer A serializes the
      // stale bytes and settles, leaving the fragment ahead of Y.Text.
      const echo = mdManager.parse(ytext.toString()) as JSONContent;
      expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
      doc.transact(() => {
        updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, 'wysiwyg-echo');
      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
      expect(ytext.toString()).not.toContain(PENDING_LINE);

      // Source-editor write over the live doc: drives an Observer B re-derive that
      // would rebuild the fragment from stale Y.Text and stomp the keystroke.
      doc.transact(() => {
        ytext.insert(ytext.length, '\nAnother source line.\n');
      }, 'external-peer');

      // The guard deferred: the keystroke is still in the server fragment.
      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  /**
   * The OFF arm. Without it the ON arm alone is satisfied by a guard that is
   * hardcoded on: the whole point of this tier is the
   * `.ok/config.yml` → `createServer` → observers wiring, and only a run that
   * flips the config can show that read is live. The rig-tier kill-switch pair
   * exercises a different path.
   *
   */
  test(
    'with the guard config-disabled the same staging stomps the keystroke',
    async () => {
      ownedContentDir = guardDisabledContentDir();
      server = await createTestServer({ contentDir: ownedContentDir, keepContentDir: true });
      ownedContentDir = server.contentDir;
      const docName = `defer-off-${crypto.randomUUID().slice(0, 8)}`;
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
      });
      expect(res.status).toBe(200);

      const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
      const state = getServerState(server, docName);
      const ytext = state?.ytext as Y.Text;
      const fragment = state?.fragment as Y.XmlFragment;

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10_000);
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
      // Precondition: the staging really did leave the fragment ahead of Y.Text,
      // so the assertion below is about the guard and not about a no-op staging.
      expect(serializeFragment(fragment)).toContain(PENDING_LINE);
      expect(ytext.toString()).not.toContain(PENDING_LINE);

      doc.transact(() => {
        ytext.insert(ytext.length, '\nAnother source line.\n');
      }, 'external-peer');

      // No guard: the re-derive rebuilt the fragment from Y.Text and the
      // un-propagated keystroke is gone. The document itself is intact — this is
      // the specific loss the ON arm prevents, not a wiped doc.
      const afterOff = serializeFragment(fragment);
      expect(afterOff).not.toContain(PENDING_LINE);
      expect(afterOff).toContain(STALE_LINE);
      expect(afterOff).toContain('Another source line.');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
