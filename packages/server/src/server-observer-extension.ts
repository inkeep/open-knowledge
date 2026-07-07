/**
 * Hocuspocus extension that attaches server-authoritative observers per-document.
 *
 * Uses the Document reference from afterLoadDocument payload directly (Document
 * extends Y.Doc). This avoids openDirectConnection's connection-count increment
 * which would prevent documents from unloading during server shutdown.
 *
 * Skips __system__ and config docs (markdown bridge is markdown-only;
 * config docs are Y.Text-only).
 */
import type { Extension } from '@hocuspocus/server';
import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { incrementServerObserverError } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';
import type { ShadowRef } from './shadow-repo.ts';

export interface ServerObserverExtensionOptions {
  mdManager: MarkdownManager;
  schema: Schema;
  /**
   * Shadow-repo reference threaded into Observer A Path B so content-loss
   * violations can write silent rescue checkpoints. Omit when no shadow is
   * available (e.g., minimal integration harness) — Path B then skips the
   * checkpoint but still emits structured telemetry.
   */
  shadowRef?: ShadowRef;
  /** Resolver for the current project branch name. Defaults to 'main'. */
  getCurrentBranch?: () => string | null;
  /** Absolute content root used to place the rescue blob inside the commit tree. */
  contentRoot?: string;
  /**
   * Basename-index resolver for `![[photo.png]]` wiki-embed refs, threaded
   * into Observer B's `mdManager.parse` call so the resulting PM image/link
   * carries the resolved src/href. Omit in unit tests — handler falls back
   * to literal target.
   */
  resolveEmbed?: (basename: string, sourcePath: string) => string | null;
  /**
   * Byte-size resolver for `![[file.ext]]` wikilinks whose extension is
   * in `FILE_ATTACHMENT_EXTENSIONS`. The wikiLinkEmbed handler calls
   * this with the same `(target, sourcePath)` it passes to
   * `resolveEmbed`; the result is formatted via `formatFileSize` and
   * stamped on the jsxComponent's `size` prop so the File row's size
   * span survives reloads. Server-side only (`fs.statSync` against the
   * resolved disk path); omit in unit tests / client-side parses where
   * `WikiEmbedFile.translateProps` then renders without a size span.
   */
  resolveSize?: (basename: string, sourcePath: string) => number | null;
}

/**
 * Create a Hocuspocus extension that attaches server observers per-document.
 *
 * - afterLoadDocument: attaches observers using the Document from the hook payload
 * - afterUnloadDocument: detaches observers (clears debounces)
 * - Skips __system__ doc (CC1 broadcast pseudo-doc)
 */
export function createServerObserverExtension(opts: ServerObserverExtensionOptions): Extension {
  const cleanups = new Map<string, () => void>();
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    async afterLoadDocument({ documentName, document }) {
      if (isSystemDoc(documentName) || isConfigDoc(documentName)) return;
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
          });
          cleanups.set(documentName, unsubscribe);
          return true;
        } catch (err) {
          // Do NOT re-throw: Hocuspocus afterLoadDocument is not try/catch guarded
          // (unlike onLoadDocument). Re-throwing would break the document setup
          // pipeline (beforeBroadcastStateless, awareness wiring) for ALL clients.
          console.error(
            `[ServerObserverExtension] Failed to attach observers for '${documentName}':`,
            err,
          );
          incrementServerObserverError('a');
          incrementServerObserverError('b');
          return false;
        }
      };

      if (!attach()) {
        // Single delayed retry for transient failures (schema init timing,
        // temporary resource exhaustion). If the retry also fails, the
        // document remains degraded — the underlying cause is likely
        // persistent and requires investigation via error counters.
        // Tracked so afterUnloadDocument can cancel if the doc unloads
        // before the retry fires (prevents orphaned observer attachment).
        const retryId = setTimeout(() => {
          pendingRetries.delete(documentName);
          if (cleanups.has(documentName)) return; // already attached (e.g., unload+reload)
          console.warn(
            `[ServerObserverExtension] Retrying observer attachment for '${documentName}'`,
          );
          attach();
        }, 5000);
        pendingRetries.set(documentName, retryId);
      }
    },

    async afterUnloadDocument({ documentName }) {
      // Cancel pending retry to prevent orphaned observer attachment
      const pending = pendingRetries.get(documentName);
      if (pending) {
        clearTimeout(pending);
        pendingRetries.delete(documentName);
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
          console.error(`[ServerObserverExtension] Cleanup failed for '${docName}':`, err);
        }
      }
      cleanups.clear();
    },
  };
}
