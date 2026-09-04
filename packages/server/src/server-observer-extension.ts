import type { Extension } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { attachQuiescenceTracker } from './bridge-quiescence.ts';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { getLogger } from './logger.ts';
import type { LossCaptureRing } from './loss-capture.ts';
import { incrementServerObserverError } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';
import type { ShadowRef } from './shadow-repo.ts';

const log = getLogger('server-observers');

export interface ServerObserverExtensionOptions {
  mdManager: MarkdownManager;
  schema: Schema;
  shadowRef?: ShadowRef;
  getCurrentBranch?: () => string | null;
  contentRoot?: string;
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  deferGuardEnabled?: boolean;
  lossDetectorEnabled?: boolean;
  fixedPointBackstopEnabled?: boolean;
  preDrainEnabled?: boolean;
  lossRing?: LossCaptureRing;
}

const BRIDGE_DISABLED = true;
export function createServerObserverExtension(opts: ServerObserverExtensionOptions): Extension {
  log.info({}, '[ServerObserverExtension] markdown bridge not attached — Y.Text is the only CRDT');

  const cleanups = new Map<string, () => void>();
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const quiescenceDetachers = new Map<string, () => void>();

  return {
    async afterLoadDocument({ documentName, document }) {
      if (!quiescenceDetachers.has(documentName)) {
        quiescenceDetachers.set(
          documentName,
          attachQuiescenceTracker(document as unknown as Y.Doc),
        );
      }
      if (BRIDGE_DISABLED) return;
      if (
        isSystemDoc(documentName) ||
        isConfigDoc(documentName) ||
        isMermaidDoc(documentName) ||
        isExcalidrawDoc(documentName) ||
        isEditableTextDoc(documentName)
      )
        return;
      if (cleanups.has(documentName)) return;

      const doc = document as unknown as Y.Doc;
      const xmlFragment = doc.getXmlFragment('default');
      const ytext = doc.getText('source');

      const attach = (): boolean => {
        try {
          const unsubscribe = setupServerObservers({
            doc,
            xmlFragment,
            ytext,
            mdManager: opts.mdManager,
            schema: opts.schema,
            docName: documentName,
            shadow: opts.shadowRef ? () => opts.shadowRef?.current : undefined,
            getBranch: opts.getCurrentBranch
              ? () => opts.getCurrentBranch?.() ?? 'main'
              : undefined,
            contentRoot: opts.contentRoot,
            resolveEmbed: opts.resolveEmbed,
            resolveSize: opts.resolveSize,
            deferGuardEnabled: opts.deferGuardEnabled,
            lossDetectorEnabled: opts.lossDetectorEnabled,
            fixedPointBackstopEnabled: opts.fixedPointBackstopEnabled,
            preDrainEnabled: opts.preDrainEnabled,
            lossRing: opts.lossRing,
          });
          cleanups.set(documentName, unsubscribe);
          return true;
        } catch (err) {
          log.error(
            { docName: documentName, err },
            `[ServerObserverExtension] Failed to attach observers for '${documentName}'`,
          );
          incrementServerObserverError('a');
          incrementServerObserverError('b');
          return false;
        }
      };

      if (!attach()) {
        const retryId = setTimeout(() => {
          pendingRetries.delete(documentName);
          if (cleanups.has(documentName)) return;
          log.warn(
            { docName: documentName },
            `[ServerObserverExtension] Retrying observer attachment for '${documentName}'`,
          );
          attach();
        }, 5000);
        pendingRetries.set(documentName, retryId);
      }
    },

    async afterUnloadDocument({ documentName }) {
      const pending = pendingRetries.get(documentName);
      if (pending) {
        clearTimeout(pending);
        pendingRetries.delete(documentName);
      }

      const detachQuiescence = quiescenceDetachers.get(documentName);
      if (detachQuiescence) {
        detachQuiescence();
        quiescenceDetachers.delete(documentName);
      }

      const cleanup = cleanups.get(documentName);
      if (!cleanup) return;
      cleanup();
      cleanups.delete(documentName);
    },

    async onDestroy() {
      for (const id of pendingRetries.values()) clearTimeout(id);
      pendingRetries.clear();

      for (const [docName, cleanup] of cleanups.entries()) {
        try {
          cleanup();
        } catch (err) {
          log.error({ docName, err }, `[ServerObserverExtension] Cleanup failed for '${docName}'`);
        }
      }
      cleanups.clear();

      for (const [docName, detach] of quiescenceDetachers.entries()) {
        try {
          detach();
        } catch (err) {
          log.error(
            { docName, err },
            `[ServerObserverExtension] Quiescence detach failed for '${docName}'`,
          );
        }
      }
      quiescenceDetachers.clear();
    },
  };
}
