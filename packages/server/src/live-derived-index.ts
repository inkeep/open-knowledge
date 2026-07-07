import type { Document, Extension } from '@hocuspocus/server';
import type { BacklinkIndex } from './backlink-index.ts';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import type { TagIndex } from './tag-index.ts';

export const LIVE_DERIVED_INDEX_DEBOUNCE_MS = 100;

export interface LiveDerivedIndexOptions {
  backlinkIndex: BacklinkIndex;
  /**
   * Optional. When wired, every backlink-update tick also re-extracts tags
   * for the changed doc and broadcasts the `'tags'` derived-view channel so
   * tag-aware UIs can invalidate their caches alongside backlinks/graph.
   */
  tagIndex?: TagIndex;
  signalChannel?: (channel: 'files' | 'backlinks' | 'graph' | 'tags') => void;
  debounceMs?: number;
}

interface LocalOriginLike {
  source: 'local';
  context?: {
    origin?: string;
  };
}

function isLocalOriginLike(origin: unknown): origin is LocalOriginLike {
  if (typeof origin !== 'object' || origin === null) return false;
  return (origin as { source?: unknown }).source === 'local';
}

function serializeLiveDocument(document: Document): string {
  // Y.Text-is-truth contract (precedent #38): body source is the raw user
  // bytes in `Y.Text('source')`. Reading from serialize(fragment) would
  // emit canonical bytes (e.g., `[https://x](https://x)` instead of the
  // user's typed `<https://x>` autolink form), making backlink snippets
  // reflect a form the user never chose.
  return document.getText('source').toString();
}

export function createLiveDerivedIndexExtension(options: LiveDerivedIndexOptions): Extension {
  const {
    backlinkIndex,
    tagIndex,
    signalChannel,
    debounceMs = LIVE_DERIVED_INDEX_DEBOUNCE_MS,
  } = options;
  const pendingByDoc = new Map<string, ReturnType<typeof setTimeout>>();

  function clearPending(docName: string): void {
    const pending = pendingByDoc.get(docName);
    if (pending) {
      clearTimeout(pending);
      pendingByDoc.delete(docName);
    }
  }

  function schedule(docName: string, document: Document): void {
    clearPending(docName);
    pendingByDoc.set(
      docName,
      setTimeout(() => {
        pendingByDoc.delete(docName);
        try {
          const markdown = serializeLiveDocument(document);
          backlinkIndex.updateDocumentFromMarkdown(docName, markdown);
          signalChannel?.('backlinks');
          signalChannel?.('graph');
          if (tagIndex) {
            tagIndex.updateDocumentFromMarkdown(docName, markdown);
            signalChannel?.('tags');
          }
        } catch (err) {
          console.error(`[live-derived-index] Failed to update derived views for ${docName}:`, err);
        }
      }, debounceMs),
    );
  }

  return {
    async onChange({ documentName, document, transactionOrigin }) {
      if (isLinkIndexExcludedDoc(documentName)) return;

      // Disk events already update the derived views directly in the watcher path.
      if (
        isLocalOriginLike(transactionOrigin) &&
        transactionOrigin.context?.origin === 'file-watcher'
      ) {
        return;
      }

      // Give the source/tree bridge a short trailing window to converge so we
      // derive links from settled live document state instead of the 2s store debounce.
      schedule(documentName, document);
    },

    async beforeUnloadDocument({ documentName }) {
      clearPending(documentName);
    },

    async onDestroy() {
      for (const timeout of pendingByDoc.values()) {
        clearTimeout(timeout);
      }
      pendingByDoc.clear();
    },
  };
}
