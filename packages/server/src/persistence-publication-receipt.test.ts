import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createPersistenceExtension } from './persistence.ts';
import {
  createReceiptFixture,
  type ReceiptOptions,
  replaceParagraphs,
} from './persistence-publication-receipt.test-helper.ts';
import { BROWSER_ORIGIN } from './persistence-store-overlap.test-helper.ts';

describe('successful publication receipt ownership', () => {
  let fixture: Awaited<ReturnType<typeof createReceiptFixture>>;

  beforeEach(async () => {
    fixture = await createReceiptFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test('ordinary publication remains usable without a receipt consumer', async () => {
    const persistence = createPersistenceExtension({
      contentDir: fixture.contentDir,
      projectDir: fixture.contentDir,
      gitEnabled: false,
      durabilityState: fixture.durability,
    });
    replaceParagraphs(fixture.original, ['ordinary publication']);
    await persistence.forceStore(fixture.original, fixture.docName);
    expect(fixture.disk()).toBe('ordinary publication\n');
    expect(fixture.durability.getReconciledBase(fixture.docName)).toBe('ordinary publication\n');
  });

  test.each(['capture', 'completion'] as const)(
    'a receipt consumer failure during %s does not change publication',
    async (phase) => {
      const fail = () => {
        throw new Error('Receipt consumer cannot accept the occurrence');
      };
      const options: ReceiptOptions = {
        contentDir: fixture.contentDir,
        projectDir: fixture.contentDir,
        gitEnabled: false,
        durabilityState: fixture.durability,
        capturePublicationReceipt: phase === 'capture' ? fail : () => fail,
      };
      const persistence = createPersistenceExtension(options);
      replaceParagraphs(fixture.original, ['published despite consumer failure']);
      await persistence.forceStore(fixture.original, fixture.docName);
      expect(fixture.disk()).toBe('published despite consumer failure\n');
      expect(fixture.durability.getReconciledBase(fixture.docName)).toBe(
        'published despite consumer failure\n',
      );
    },
  );

  test('real publication retains its captured occurrence only after the bytes land', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['published']);
    const occurrence = authority.begin(original, docName);
    const expectedSV = Y.encodeStateVector(original);
    const hold = fixture.holdNextPublication();
    const store = fixture.store();
    await hold.waitUntilHeld(store);
    expect(fixture.disk()).toBe('initial\n');
    expect(authority.canRetire(occurrence)).toBe(true);
    hold.release();
    await store;
    expect(fixture.disk()).toBe('published\n');
    expect(authority.canRetire(occurrence)).toBe(false);
    expect(occurrence.publication?.snapshotSV).toEqual(expectedSV);
  });

  test('a reused Document receives a fresh receipt for each successful occurrence', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['first publication']);
    const first = authority.begin(original, docName);
    await fixture.store();
    expect(fixture.disk()).toBe('first publication\n');
    expect(authority.canRetire(first)).toBe(false);

    replaceParagraphs(original, ['second publication']);
    const second = authority.begin(original, docName);
    expect(second.document).toBe(first.document);
    expect(authority.canRetire(second)).toBe(true);
    await fixture.store();
    expect(fixture.disk()).toBe('second publication\n');
    expect(authority.canRetire(second)).toBe(false);
    expect(second.publication?.snapshotSV).toEqual(Y.encodeStateVector(original));
  });

  test('completion from before same-object reuse cannot retain the replacement occurrence', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['older publication']);
    const older = authority.begin(original, docName);
    const snapshotSV = Y.encodeStateVector(original);
    const hold = fixture.holdNextPublication();
    const store = fixture.store();
    await hold.waitUntilHeld(store);

    const replacement = authority.begin(original, docName);
    expect(replacement.document).toBe(older.document);
    expect(Y.encodeStateVector(original)).toEqual(snapshotSV);
    hold.release();
    await store;

    expect(fixture.disk()).toBe('older publication\n');
    expect(authority.canRetire(older)).toBe(false);
    expect(authority.canRetire(replacement)).toBe(true);
    expect(older.publication?.snapshotSV).toEqual(snapshotSV);
  });

  test('completion for a replaced Document retains only the original object even with equal vectors', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['original object publication']);
    const older = authority.begin(original, docName);
    const hold = fixture.holdNextPublication();
    const store = fixture.store();
    await hold.waitUntilHeld(store);

    const replacementDocument = fixture.document();
    Y.applyUpdate(replacementDocument, Y.encodeStateAsUpdate(original));
    const replacement = authority.begin(replacementDocument, docName);
    expect(replacementDocument).not.toBe(original);
    expect(Y.encodeStateVector(replacementDocument)).toEqual(Y.encodeStateVector(original));
    expect(replacementDocument.getText('source').toString()).toBe(
      original.getText('source').toString(),
    );
    hold.release();
    await store;

    expect(fixture.disk()).toBe('original object publication\n');
    expect(authority.canRetire(older)).toBe(false);
    expect(authority.canRetire(replacement)).toBe(true);
  });

  test('an earlier completion cannot retain a later deletion-only mutation with the same vector', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['published suffix']);
    const older = authority.begin(original, docName);
    const snapshotSV = Y.encodeStateVector(original);
    const hold = fixture.holdNextPublication();
    const store = fixture.store();
    await hold.waitUntilHeld(store);

    original.transact(() => {
      original.getText('source').delete('published'.length, ' suffix'.length);
      const paragraph = original.getXmlFragment('default').get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error('Expected a paragraph');
      const text = paragraph.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('Expected paragraph text');
      text.delete('published'.length, ' suffix'.length);
    }, BROWSER_ORIGIN);
    const deletion = authority.begin(original, docName);
    expect(original.getText('source').toString()).toBe('published\n');
    expect(Y.encodeStateVector(original)).toEqual(snapshotSV);
    hold.release();
    await store;

    expect(fixture.disk()).toBe('published suffix\n');
    expect(authority.canRetire(older)).toBe(false);
    expect(authority.canRetire(deletion)).toBe(true);
    await fixture.store();
    expect(fixture.disk()).toBe('published\n');
    expect(authority.canRetire(deletion)).toBe(false);
  });

  test('a superseded store cannot retain the occurrence whose bytes never publish', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['older snapshot']);
    const older = authority.begin(original, docName);
    const hold = fixture.holdNextPublication();
    const firstStore = fixture.store();
    await hold.waitUntilHeld(firstStore);
    expect(fixture.disk()).toBe('initial\n');
    expect(authority.canRetire(older)).toBe(true);

    replaceParagraphs(original, ['newer snapshot']);
    const newer = authority.begin(original, docName);
    await fixture.store();
    expect(fixture.disk()).toBe('newer snapshot\n');
    expect(authority.canRetire(newer)).toBe(false);
    hold.release();
    await firstStore;
    expect(fixture.disk()).toBe('newer snapshot\n');
    expect(authority.canRetire(older)).toBe(true);
    expect(authority.canRetire(newer)).toBe(false);
  });

  test('semantically unchanged Markdown leaves retirement allowed until an actual publication', async () => {
    const { original, authority, docName } = fixture;
    original.transact(() => original.getText('source').delete('initial'.length, 1), BROWSER_ORIGIN);
    const unchanged = authority.begin(original, docName);
    expect(original.getText('source').toString()).toBe('initial');
    await fixture.store();
    expect(fixture.disk()).toBe('initial\n');
    expect(authority.canRetire(unchanged)).toBe(true);

    replaceParagraphs(original, ['changed']);
    const changed = authority.begin(original, docName);
    await fixture.store();
    expect(fixture.disk()).toBe('changed\n');
    expect(authority.canRetire(changed)).toBe(false);
    expect(authority.canRetire(unchanged)).toBe(true);
  });

  test('a phantom write leaves retirement allowed until nonempty content is published', async () => {
    const { authority } = fixture;
    const docName = 'phantom';
    const document = fixture.document(docName);
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const phantom = authority.begin(document, docName);
    expect(document.getText('source').toString()).toBe('');
    await fixture.store(document, docName);
    expect(existsSync(docPath)).toBe(false);
    expect(authority.canRetire(phantom)).toBe(true);

    replaceParagraphs(document, ['now present']);
    const content = authority.begin(document, docName);
    await fixture.store(document, docName);
    expect(readFileSync(docPath, 'utf8')).toBe('now present\n');
    expect(authority.canRetire(content)).toBe(false);
    expect(authority.canRetire(phantom)).toBe(true);
  });

  test('an invalid path refusal cannot retain an occurrence', async () => {
    const { original, authority, durability } = fixture;
    const invalidName = 'invalid\0path';
    replaceParagraphs(original, ['refused bytes']);
    durability.setReconciledBase(invalidName, 'initial\n');
    const refused = authority.begin(original, invalidName);
    const entries = readdirSync(fixture.contentDir).sort();
    await expect(fixture.store(original, invalidName)).rejects.toThrow('Invalid document name');
    expect(authority.canRetire(refused)).toBe(true);
    expect(readdirSync(fixture.contentDir).sort()).toEqual(entries);
    expect(fixture.disk()).toBe('initial\n');

    const valid = authority.begin(original, fixture.docName);
    await fixture.store();
    expect(fixture.disk()).toBe('refused bytes\n');
    expect(authority.canRetire(valid)).toBe(false);
    expect(authority.canRetire(refused)).toBe(true);
  });

  test('a real filesystem failure leaves retirement allowed', async () => {
    const { original, authority, docName } = fixture;
    replaceParagraphs(original, ['unpublished']);
    const occurrence = authority.begin(original, docName);
    rmSync(fixture.docPath);
    mkdirSync(fixture.docPath);
    await expect(fixture.store()).rejects.toThrow();
    expect(readdirSync(fixture.docPath)).toEqual([]);
    expect(authority.canRetire(occurrence)).toBe(true);

    rmSync(fixture.docPath, { recursive: true });
    writeFileSync(fixture.docPath, 'initial\n');
    await fixture.store();
    expect(fixture.disk()).toBe('unpublished\n');
    expect(authority.canRetire(occurrence)).toBe(false);
  });

  test('a deferred store retains the occurrence actually published by the drain', async () => {
    const { original, authority, durability, docName, persistence } = fixture;
    const releaseAdmission = fixture.holdWriteAdmission();
    replaceParagraphs(original, ['queued']);
    const queued = authority.begin(original, docName);
    durability.setBatchInProgress(true);
    await fixture.store();
    expect(fixture.disk()).toBe('initial\n');
    expect(authority.canRetire(queued)).toBe(true);
    const outcome = durability.awaitDeferredStoreOutcome(docName);

    replaceParagraphs(original, ['published by drain']);
    const drained = authority.begin(original, docName);
    durability.setBatchInProgress(false);
    await persistence.flushDeferredStores('within-branch');
    await expect(outcome).resolves.toEqual({ kind: 'completed' });
    releaseAdmission();
    expect(fixture.disk()).toBe('published by drain\n');
    expect(authority.canRetire(drained)).toBe(false);
    expect(authority.canRetire(queued)).toBe(true);
    expect(drained.publication?.snapshotSV).toEqual(Y.encodeStateVector(original));
  });

  test('discarding a deferred store leaves its occurrence eligible for retirement', async () => {
    const { original, authority, durability, docName, persistence } = fixture;
    const releaseAdmission = fixture.holdWriteAdmission();
    replaceParagraphs(original, ['discarded branch edit']);
    const discarded = authority.begin(original, docName);
    durability.setBatchInProgress(true);
    await fixture.store();
    const outcome = durability.awaitDeferredStoreOutcome(docName);
    expect(authority.canRetire(discarded)).toBe(true);
    expect(fixture.disk()).toBe('initial\n');
    durability.switchReconciledBaseScope('other');
    writeFileSync(fixture.docPath, 'other branch\n');
    durability.setBatchInProgress(false);
    await persistence.flushDeferredStores('discard-stale');
    await expect(outcome).resolves.toEqual({ kind: 'discarded' });
    releaseAdmission();
    expect(fixture.disk()).toBe('other branch\n');
    expect(authority.canRetire(discarded)).toBe(true);

    durability.setReconciledBase(docName, 'other branch\n');
    replaceParagraphs(original, ['new branch edit']);
    const current = authority.begin(original, docName);
    await fixture.store();
    expect(fixture.disk()).toBe('new branch edit\n');
    expect(authority.canRetire(current)).toBe(false);
    expect(authority.canRetire(discarded)).toBe(true);
  });
});
