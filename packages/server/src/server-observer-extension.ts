/**
 * Hocuspocus extension that attaches server-authoritative observers per-document.
 *
 * Uses the Document reference from afterLoadDocument payload directly (Document
 * extends Y.Doc). This avoids openDirectConnection's connection-count increment
 * which would prevent documents from unloading during server shutdown.
 *
 * The markdown bridge is not attached: every client derives its ProseMirror
 * document locally from `Y.Text`, so the `Y.XmlFragment` has no readers. What
 * this extension does attach is the per-document quiescence tracker, which
 * persistence needs and which reads `Y.Doc` transactions only.
 */
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
  /**
   * Derive-timing defer guard kill-switch, resolved from `.ok/config.yml`
   * (`bridge.deferGuard.enabled`, default ON). Threaded per-document into
   * `setupServerObservers`.
   */
  deferGuardEnabled?: boolean;
  /**
   * Bridge content-loss detector kill-switch, resolved from `.ok/config.yml`
   * (`bridge.lossDetector.enabled`, default ON). Threaded per-document into
   * `setupServerObservers` for the Observer-A apply post-condition.
   */
  lossDetectorEnabled?: boolean;
  /**
   * Re-derive-loop fixed-point backstop kill-switch, resolved from
   * `.ok/config.yml` (`bridge.fixedPoint.enabled`, default ON). Threaded
   * per-document into `setupServerObservers`.
   */
  fixedPointBackstopEnabled?: boolean;
  /**
   * Pre-drain discriminator kill-switch, resolved from `.ok/config.yml`
   * (`bridge.preDrain.enabled`, default ON). Threaded per-document into
   * `setupServerObservers`; the doc's pre-drain controller stays registered
   * either way, but flushes only when enabled.
   */
  preDrainEnabled?: boolean;
  /**
   * Content-free loss-capture ring, constructed once at boot (gated on
   * `lossCapture.enabled`). Each derive-timing defer records a `guard-defer`
   * event, each detector trip a `detector-trip` event, and each backstop trip a
   * `backstop-trip` event through it. Omit when no ring is wired (unit harness).
   */
  lossRing?: LossCaptureRing;
}

/**
 * The bridge never runs. Clients derive their ProseMirror document from
 * `Y.Text` (see `projection-binding.ts`), so nothing reads the
 * `Y.XmlFragment`; attaching the bridge would have Observer A serialize a
 * fragment nobody updates and line-diff it back over `Y.Text`, reverting edits.
 *
 * A named constant rather than an inline deletion: the observer machinery it
 * gates comes out in stages, and one named seam keeps each stage's remaining
 * arm obvious. It goes with the last of them.
 */
const BRIDGE_DISABLED = true;

/**
 * Create the Hocuspocus extension that manages per-document server state.
 *
 * - afterLoadDocument: attaches the quiescence tracker using the Document from
 *   the hook payload; the bridge observers are gated off by `BRIDGE_DISABLED`
 * - afterUnloadDocument: detaches the tracker and any observer cleanup
 * - Skips __system__ doc (CC1 broadcast pseudo-doc) for the observer arm
 */
export function createServerObserverExtension(opts: ServerObserverExtensionOptions): Extension {
  // Once per server, while the machinery is present but inert: an inert bridge
  // and a working one are otherwise indistinguishable from the logs. Drop this
  // line with the rest of the observer machinery.
  log.info({}, '[ServerObserverExtension] markdown bridge not attached — Y.Text is the only CRDT');

  const cleanups = new Map<string, () => void>();
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Quiescence detachers, keyed per document.
   *
   * Separate from `cleanups` because the two have different lifetimes: a doc
   * the bridge declines has no observer cleanup but still has a tracker, and
   * conflating them would either skip the detach or make the "already
   * attached?" check answer for the wrong thing.
   */
  const quiescenceDetachers = new Map<string, () => void>();

  return {
    async afterLoadDocument({ documentName, document }) {
      // Quiescence tracking comes FIRST, and stays outside every skip below.
      //
      // It reads `Y.Doc` transactions only — nothing about the fragment — but
      // persistence gates every write on `isDocQuiescent`, and the counters
      // start equal, so a doc with no tracker reports `settledGen >
      // lastUserTxGen` as false forever and never persists. Any skip that
      // swallowed it would mean "this doc never settles".
      //
      // Detached on unload via its own map, whose lifetime differs from the
      // observer cleanups'.
      if (!quiescenceDetachers.has(documentName)) {
        quiescenceDetachers.set(
          documentName,
          attachQuiescenceTracker(document as unknown as Y.Doc),
        );
      }

      // Mermaid docs are Y.Text-only like config docs — the markdown bridge must
      // NOT run (it would re-canonicalize the diagram source through remark).
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
          // Do NOT re-throw: Hocuspocus afterLoadDocument is not try/catch guarded
          // (unlike onLoadDocument). Re-throwing would break the document setup
          // pipeline (beforeBroadcastStateless, awareness wiring) for ALL clients.
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
        // Single delayed retry for transient failures (schema init timing,
        // temporary resource exhaustion). If the retry also fails, the
        // document remains degraded — the underlying cause is likely
        // persistent and requires investigation via error counters.
        // Tracked so afterUnloadDocument can cancel if the doc unloads
        // before the retry fires (prevents orphaned observer attachment).
        const retryId = setTimeout(() => {
          pendingRetries.delete(documentName);
          if (cleanups.has(documentName)) return; // already attached (e.g., unload+reload)
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
      // Cancel pending retry to prevent orphaned observer attachment
      const pending = pendingRetries.get(documentName);
      if (pending) {
        clearTimeout(pending);
        pendingRetries.delete(documentName);
      }

      // Before the observer cleanup's early return below: a doc the bridge
      // declined has a tracker and no cleanup, so returning first would leak it.
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
