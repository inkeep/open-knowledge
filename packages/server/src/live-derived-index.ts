import type { Document, Extension } from '@hocuspocus/server';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import type { DerivedDocumentIndexLivePort } from './derived-document-index.ts';
import { getLogger } from './logger.ts';

export const LIVE_DERIVED_INDEX_DEBOUNCE_MS = 100;

export interface LiveDerivedIndexOptions {
  derivedDocumentIndex: DerivedDocumentIndexLivePort;
  /**
   * Optional. Re-anchors the doc's comment threads against its settled text, so
   * a deleted passage reads as orphaned instead of staying healthy-looking
   * until someone tries to send it.
   *
   * A callback rather than a direct dependency because the comment service is
   * built inside the API extension, which is constructed after this one. It
   * owns its own signalling — a state change is what warrants telling clients,
   * and only it knows whether one happened.
   */
  onDocumentSettled?: (docName: string) => void;
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
    derivedDocumentIndex,
    onDocumentSettled,
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

  function schedule(docName: string, document: Document, token: number): void {
    clearPending(docName);
    pendingByDoc.set(
      docName,
      setTimeout(() => {
        pendingByDoc.delete(docName);
        try {
          const markdown = serializeLiveDocument(document);
          void derivedDocumentIndex.recordLiveDocument(docName, markdown, token).catch((err) => {
            getLogger('live-derived-index').error(
              { docName, err },
              `Failed to update derived views for ${docName}`,
            );
          });
          // Anchors are measured against the doc BODY, not the source bytes
          // above — so this re-reads rather than reusing `markdown`, which
          // still carries the frontmatter region.
          onDocumentSettled?.(docName);
        } catch (err) {
          getLogger('live-derived-index').error(
            { docName, err },
            `Failed to update derived views for ${docName}`,
          );
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

      const token = derivedDocumentIndex.captureLiveUpdateToken();
      if (token === null) {
        clearPending(documentName);
        return;
      }

      // Give the source/tree bridge a short trailing window to converge so we
      // derive links from settled live document state instead of the 2s store debounce.
      schedule(documentName, document, token);
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
