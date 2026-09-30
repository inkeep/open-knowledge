import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  clientIdsInDoc,
  createRestartableServer,
  pollUntil,
  seedPoolServerInstanceId,
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
  test('REPRO: fast restart — Y.Text preserves content once', async () => {
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

    const preYtext = doc.getText('source').toString();
    const preSection1Text = (preYtext.match(/## Section 1/g) ?? []).length;
    expect(preSection1Text).toBe(1);

    const preClientIds = clientIdsInDoc(doc);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await wait(500);

    const activeEntry = pool.getActive();
    if (!activeEntry) throw new Error('pool has no active entry post-restart');
    const postDoc = activeEntry.provider.document;
    const postClientIds = clientIdsInDoc(postDoc);

    const postYtext = postDoc.getText('source').toString();
    const postSection1Text = (postYtext.match(/## Section 1/g) ?? []).length;
    const postSection2Text = (postYtext.match(/## Section 2/g) ?? []).length;
    const postWikiText = (postYtext.match(/\[\[t10-wiki-link\]\]/g) ?? []).length;

    console.log('[T10] marker counts', {
      ytext: {
        section1: postSection1Text,
        section2: postSection2Text,
        wiki: postWikiText,
        bytes: postYtext.length,
      },
      clientIds: {
        pre: [...preClientIds],
        post: [...postClientIds],
      },
    });

    expect(postSection1Text).toBe(1);
    expect(postSection2Text).toBe(1);
    expect(postWikiText).toBe(1);
  }, 30_000);
});
