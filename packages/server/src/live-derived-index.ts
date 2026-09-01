import type { Document, Extension } from '@hocuspocus/server';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import type { DerivedDocumentIndexLivePort } from './derived-document-index.ts';
import { getLogger } from './logger.ts';

export const LIVE_DERIVED_INDEX_DEBOUNCE_MS = 100;

export interface LiveDerivedIndexOptions {
  derivedDocumentIndex: DerivedDocumentIndexLivePort;
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
  return document.getText('source').toString();
}

export function createLiveDerivedIndexExtension(options: LiveDerivedIndexOptions): Extension {
  const {
    derivedDocumentIndex,
    onDocumentSettled,
    debounceMs = LIVE_DERIVED_INDEX_DEBOUNCE_MS,
  } = options;
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
        onDocumentSettled?.(docName);
      })
      .catch((err) => {
        getLogger('live-derived-index').error(
          { docName, err },
          `Failed to update derived views for ${docName}`,
        );
      });
  }

  async function flushPending(docName: string): Promise<void> {
    const pending = pendingByDoc.get(docName);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingByDoc.delete(docName);
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
