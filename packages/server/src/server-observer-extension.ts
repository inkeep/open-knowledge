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
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { anyPeerNeedsFragment } from './fragment-demand-policy.ts';
import { resumeFragmentDerive } from './fragment-derive-demand.ts';
import { getLogger } from './logger.ts';
import type { LossCaptureRing } from './loss-capture.ts';
import { incrementServerObserverError } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';
import type { ShadowRef } from './shadow-repo.ts';

const log = getLogger('server-observers');

/**
 * The slice of y-protocols' Awareness this extension uses. Structural rather
 * than imported so the server does not take a dependency on the awareness
 * package for three members.
 */
interface DocAwareness {
  clientID: number;
  getStates(): ReadonlyMap<number, { mode?: unknown } | undefined>;
  on(event: 'update', handler: () => void): void;
  off(event: 'update', handler: () => void): void;
}

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
  /**
   * Enable the fragment-derive demand gate: skip Observer B's rebuild while no
   * connected peer needs the derived WYSIWYG fragment, and pay a catch-up
   * derive when one does.
   *
   * Defaults to OFF. The bridge's other six switches set the precedent — a new
   * behaviour that can make the fragment deliberately stale ships dark and is
   * turned on deliberately, not inherited by every existing deployment on
   * upgrade.
   */
  deriveDemandGateEnabled?: boolean;
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
      // Mermaid docs are Y.Text-only like config docs — the markdown bridge must
      // NOT run (it would re-canonicalize the diagram source through remark).
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

      // ── Fragment-derive demand gate ────────────────────────────────────
      // Observer B rebuilds the fragment on every source-mode keystroke even
      // when nothing will read it. `awareness` tells us who is connected and
      // which surface each of them is on, so the rebuild can be skipped while
      // the answer is "nobody who needs it".
      //
      // The awareness handle is read through a getter rather than captured:
      // Hocuspocus replaces a document's awareness across some reconnect
      // paths, and a captured instance would silently answer for a dead one —
      // failing OPEN here (undefined → demand) but going stale in the
      // transition listener, which is the half that would strand a suspension.
      const awarenessOf = () => (document as unknown as { awareness?: DocAwareness }).awareness;

      const fragmentDemand = (): boolean => {
        const awareness = awarenessOf();
        // No awareness instance means no way to know who is watching. Derive.
        if (awareness === undefined) return true;
        try {
          return anyPeerNeedsFragment(awareness.getStates(), awareness.clientID);
        } catch (err) {
          // A throw here must not decide "skip". Fail open and say so once per
          // occurrence — a demand predicate that silently starts returning
          // false is indistinguishable from a quiet document.
          log.warn(
            { docName: documentName, err },
            '[ServerObserverExtension] demand predicate threw — deriving',
          );
          return true;
        }
      };

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
            // Undefined keeps the unconditional always-derive behaviour, so
            // the gate is genuinely inert when the switch is off rather than
            // being a predicate that happens to always return true.
            fragmentDemand: opts.deriveDemandGateEnabled ? fragmentDemand : undefined,
          });
          // Demand can return with no Y.Text edit to ride in on — a reader
          // opens the WYSIWYG on a document that has been quiet for minutes —
          // so the drain that would repair the fragment may never arrive.
          // Watch awareness for the false→true edge and pay the catch-up then.
          //
          // KNOWN WINDOW, not closed here. The catch-up is triggered by the
          // client's own awareness update, so the repaired fragment reaches it
          // about one round trip after it flipped to WYSIWYG — and for a
          // pre-mounted editor (docs under `LARGE_DOC_CHAR_THRESHOLD` mount
          // both surfaces) that means a brief flash of pre-edit content on the
          // flip. Closing it properly needs the client to withhold render until
          // it knows the fragment is current, which is a protocol change with
          // its own design; bolting a partial version onto this listener would
          // give a guarantee that only holds on fast connections, which is
          // worse than a documented window. This is the main reason
          // `deriveDemandGateEnabled` defaults to off.
          //
          // Edge-triggered, not level-triggered: awareness fires on every
          // cursor move and heartbeat, and calling the resumer on each would
          // put a predicate evaluation on a very hot path. `resumeFragmentDerive`
          // is itself a no-op when nothing is owed, so the edge check is about
          // cost, not correctness.
          let hadDemand = fragmentDemand();
          const onAwareness = (): void => {
            const nowHasDemand = fragmentDemand();
            if (nowHasDemand && !hadDemand) resumeFragmentDerive(doc);
            hadDemand = nowHasDemand;
          };
          const awareness = awarenessOf();
          awareness?.on('update', onAwareness);

          cleanups.set(documentName, () => {
            awarenessOf()?.off('update', onAwareness);
            unsubscribe();
          });
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
    },
  };
}
