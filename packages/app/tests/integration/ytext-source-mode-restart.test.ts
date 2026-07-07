/**
 * Y.Text (source-mode) duplication check.
 *
 * The Observer A initial-populate logic at
 * `packages/server/src/server-observers.ts` creates Y.Text Items under
 * the fresh server clientID on every doc load. The XmlFragment-side bug is
 * well-understood; this test isolates the Y.Text channel so the fix can
 * be verified as covering both CRDT surfaces.
 *
 * Y.Text is the CodeMirror source-mode binding. If Y.Text's items duplicate
 * independently from the XmlFragment's items, the source-mode view would show
 * doubled content even if the WYSIWYG (XmlFragment-backed) view were clean —
 * or vice versa. The test asserts both surfaces match and neither duplicates.
 *
 * Expected: PASS post-fix. Regression guard for the pre-fix bug class
 * — pre-fix, both Y.Text and XmlFragment showed doubled content on fast
 * restart. Post-fix, neither surface duplicates and the two stay in sync.
 */
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  assertBridgeInvariant,
  clientIdsInDoc,
  createRestartableServer,
  pollUntil,
  seedPoolServerInstanceId,
  serializeFragment,
} from './test-harness';

const FIXTURE = `# T10 source-mode fixture

This doc has multiple paragraphs.

## Section 1

Paragraph in section 1.

## Section 2

Paragraph in section 2.

[[t10-wiki-link]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('T10: Y.Text (source-mode) duplication on restart', () => {
  test('REPRO: fast restart — Y.Text and XmlFragment both preserve content once', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    writeFileSync(join(server.contentDir, 'test-doc.md'), FIXTURE, 'utf-8');

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);
    await wait(200);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('provider missing');
    const doc = firstProvider.document;

    // Baseline: both surfaces have the fixture content once.
    const preYtext = doc.getText('source').toString();
    const preFrag = serializeFragment(doc.getXmlFragment('default'));
    const preSection1Text = (preYtext.match(/## Section 1/g) ?? []).length;
    const preSection1Frag = (preFrag.match(/## Section 1/g) ?? []).length;
    expect(preSection1Text).toBe(1);
    expect(preSection1Frag).toBe(1);
    assertBridgeInvariant(doc.getText('source'), doc.getXmlFragment('default'));

    const preClientIds = clientIdsInDoc(doc);

    // Fast restart.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    // post-fix the authenticationFailed recycle fires and `doc` points at a
    // destroyed Y.Doc. Re-read from the pool's current active entry so
    // post-restart assertions hit the live Y.Doc.
    await wait(500);

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry post-restart');
    const postDoc = activeEntry.provider.document;
    const postClientIds = clientIdsInDoc(postDoc);

    // Both surfaces: exactly once.
    const postYtext = postDoc.getText('source').toString();
    const postFrag = serializeFragment(postDoc.getXmlFragment('default'));
    const postSection1Text = (postYtext.match(/## Section 1/g) ?? []).length;
    const postSection1Frag = (postFrag.match(/## Section 1/g) ?? []).length;
    const postSection2Text = (postYtext.match(/## Section 2/g) ?? []).length;
    const postSection2Frag = (postFrag.match(/## Section 2/g) ?? []).length;
    const postWikiText = (postYtext.match(/\[\[t10-wiki-link\]\]/g) ?? []).length;
    const postWikiFrag = (postFrag.match(/\[\[t10-wiki-link\]\]/g) ?? []).length;

    console.log('[T10] marker counts', {
      ytext: {
        section1: postSection1Text,
        section2: postSection2Text,
        wiki: postWikiText,
        bytes: postYtext.length,
      },
      frag: {
        section1: postSection1Frag,
        section2: postSection2Frag,
        wiki: postWikiFrag,
        bytes: postFrag.length,
      },
      clientIds: {
        pre: [...preClientIds],
        post: [...postClientIds],
      },
    });

    expect(postSection1Text).toBe(1);
    expect(postSection2Text).toBe(1);
    expect(postWikiText).toBe(1);
    expect(postSection1Frag).toBe(1);
    expect(postSection2Frag).toBe(1);
    expect(postWikiFrag).toBe(1);

    // Bridge invariant should still hold post-restart (a duplicated Y.Text
    // should serialize to duplicated XmlFragment, and vice versa — so if the
    // two sides DIFFER, there's a separate bug in the bridge sync).
    assertBridgeInvariant(postDoc.getText('source'), postDoc.getXmlFragment('default'));
  }, 30_000);
});
