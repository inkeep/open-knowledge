import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '@hocuspocus/server';
import { vi } from 'vitest';
import type * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import * as fsTraced from './fs-traced.ts';
import { createPersistenceExtension, type PersistenceOptions } from './persistence.ts';
import { BROWSER_ORIGIN, replaceDocParagraphs } from './persistence-store-overlap.test-helper.ts';

interface PublicationOccurrence {
  readonly document: Y.Doc;
  readonly documentName: string;
  publication: { readonly snapshotSV: Uint8Array } | null;
}

class PublicationAuthority {
  private readonly occurrences = new WeakMap<Y.Doc, PublicationOccurrence>();

  begin(document: Y.Doc, documentName: string): PublicationOccurrence {
    const occurrence: PublicationOccurrence = { document, documentName, publication: null };
    this.occurrences.set(document, occurrence);
    return occurrence;
  }

  canRetire(occurrence: PublicationOccurrence): boolean {
    return occurrence.publication === null;
  }

  capturePublicationReceipt = (
    document: Y.Doc,
    documentName: string,
    snapshotSV: Uint8Array,
  ): (() => void) | undefined => {
    const occurrence = this.occurrences.get(document);
    if (!occurrence || occurrence.documentName !== documentName) return undefined;
    const capturedSV = Uint8Array.from(snapshotSV);
    return () => {
      occurrence.publication = { snapshotSV: capturedSV };
    };
  };
}

export interface ReceiptOptions extends PersistenceOptions {
  capturePublicationReceipt?: PublicationAuthority['capturePublicationReceipt'];
}

export function replaceParagraphs(document: Y.Doc, paragraphs: string[]): void {
  document.transact(() => replaceDocParagraphs(document, paragraphs), BROWSER_ORIGIN);
}

export async function createReceiptFixture(initial = 'initial\n') {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-publication-receipt-')));
  const docName = 'receipt';
  const docPath = join(contentDir, `${docName}.md`);
  const documents = new Set<Document>();
  const stores = new Set<Promise<void>>();
  const releases = new Set<() => void>();
  const durability = new DocumentDurabilityState();
  const authority = new PublicationAuthority();
  durability.switchReconciledBaseScope('main');
  writeFileSync(docPath, initial, { flag: 'wx' });
  const options: ReceiptOptions = {
    mergeHistory: null,
    ingestDiskAtStore: null,
    contentDir,
    projectDir: contentDir,
    gitEnabled: false,
    durabilityState: durability,
    capturePublicationReceipt: authority.capturePublicationReceipt,
  };
  const persistence = createPersistenceExtension(options);

  function document(name = docName): Document {
    const result = new Document(name);
    documents.add(result);
    return result;
  }

  const original = document();
  await persistence.extension.onLoadDocument?.({
    document: original,
    documentName: docName,
    context: {},
  } as never);

  function store(target = original, name = docName): Promise<void> {
    const work = persistence.forceStore(target, name);
    stores.add(work);
    void work.then(
      () => stores.delete(work),
      () => stores.delete(work),
    );
    return work;
  }

  function holdNextPublication() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.add(release.resolve);
    const write = fsTraced.tracedWriteFile;
    let held = false;
    vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (...args) => {
      await write(...args);
      if (held || !String(args[0]).startsWith(`${docPath}.tmp.`)) return;
      held = true;
      entered.resolve();
      await release.promise;
    });
    return {
      async waitUntilHeld(work: Promise<void>): Promise<void> {
        await Promise.race([
          entered.promise,
          work.then(() => {
            throw new Error('Store completed before reaching the publication hold');
          }),
        ]);
      },
      release: release.resolve,
    };
  }

  return {
    contentDir,
    docName,
    docPath,
    original,
    persistence,
    durability,
    authority,
    document,
    store,
    holdNextPublication,
    holdWriteAdmission() {
      const release = durability.holdWriteAdmission();
      releases.add(release);
      return release;
    },
    disk: () => readFileSync(docPath, 'utf8'),
    async cleanup() {
      for (const release of releases) release();
      await Promise.allSettled(stores);
      await persistence.flushDeferredStores('discard-stale');
      vi.restoreAllMocks();
      for (const item of documents) item.destroy();
      rmSync(contentDir, { recursive: true, force: true });
      if (existsSync(contentDir)) throw new Error(`Fixture remains: ${contentDir}`);
    },
  };
}
