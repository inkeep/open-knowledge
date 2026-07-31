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
  // The document and its capture token ride along with the timer so a pending
  // update can be APPLIED on unload, not just cancelled.
  const pendingByDoc = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; document: Document; token: number }
  >();

  function clearPending(docName: string): void {
    const pending = pendingByDoc.get(docName);
    if (pending) {
      clearTimeout(pending.timer);
      pendingByDoc.delete(docName);
    }
  }

  function runUpdate(docName: string, document: Document, token: number): Promise<void> {
    let markdown: string;
    try {
      markdown = serializeLiveDocument(document);
    } catch (err) {
      getLogger('live-derived-index').error(
        { docName, err },
        `Failed to update derived views for ${docName}`,
      );
      return Promise.resolve();
    }
    return derivedDocumentIndex
      .recordLiveDocument(docName, markdown, token)
      .then(() => {
        // Anchors are measured against the doc BODY, not the source bytes
        // above, so the consumer re-reads rather than reusing `markdown`.
        // Lives here rather than at the debounce call site so the
        // apply-on-unload path notifies too.
        onDocumentSettled?.(docName);
      })
      .catch((err) => {
        getLogger('live-derived-index').error(
          { docName, err },
          `Failed to update derived views for ${docName}`,
        );
      });
  }

  /**
   * Apply a pending update NOW rather than waiting out its debounce. A document
   * that unloads inside the debounce window would otherwise lose the update
   * entirely, leaving its links and tags absent from the derived views until
   * something else re-indexes it — a write followed by a prompt unload (an
   * API-only create on an idle server, say) would simply never register.
   */
  async function flushPending(docName: string): Promise<void> {
    const pending = pendingByDoc.get(docName);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingByDoc.delete(docName);
    // Awaited, unlike the debounced path: the document is going away, so the
    // record has to land before the unload completes.
    await runUpdate(docName, pending.document, pending.token);
  }

  function schedule(docName: string, document: Document, token: number): void {
    clearPending(docName);
    pendingByDoc.set(docName, {
      document,
      token,
      timer: setTimeout(() => {
        pendingByDoc.delete(docName);
        void runUpdate(docName, document, token);
      }, debounceMs),
    });
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
      await flushPending(documentName);
    },

    async onDestroy() {
      for (const { timer } of pendingByDoc.values()) {
        clearTimeout(timer);
      }
      pendingByDoc.clear();
    },
  };
}
