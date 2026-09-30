import type { Extension } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { attachQuiescenceTracker } from './bridge-quiescence.ts';
import { getLogger } from './logger.ts';

const log = getLogger('server-observers');

/* STOP: the tracker this attaches is the persistence settle gate, not a bridge remnant.
   A document with no tracker never reports quiescent and so never persists. */
export function createServerObserverExtension(): Extension {
  const quiescenceDetachers = new Map<string, () => void>();

  const detach = (documentName: string): void => {
    const detachQuiescence = quiescenceDetachers.get(documentName);
    if (!detachQuiescence) return;
    try {
      detachQuiescence();
    } catch (err) {
      log.error(
        { docName: documentName, err },
        `[ServerObserverExtension] Quiescence detach failed for '${documentName}'`,
      );
    }
    quiescenceDetachers.delete(documentName);
  };

  return {
    async afterLoadDocument({ documentName, document }) {
      if (quiescenceDetachers.has(documentName)) return;
      quiescenceDetachers.set(documentName, attachQuiescenceTracker(document as unknown as Y.Doc));
    },

    async afterUnloadDocument({ documentName }) {
      detach(documentName);
    },

    async onDestroy() {
      for (const documentName of quiescenceDetachers.keys()) detach(documentName);
    },
  };
}
