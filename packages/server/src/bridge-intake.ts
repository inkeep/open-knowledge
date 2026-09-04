/**
 * Two sibling write-side primitives for the Y.Text-is-truth contract
 * (precedent #38). Each primitive owns one write semantics — its name is
 * the contract.
 *
 *   - `composeAndWriteRawBody` — file-watcher + agent-write: line-aligned
 *     `applyFastDiff`. Preserves unrelated whole-line Y.Text Items + their
 *     origins; changed lines land as fresh contiguous runs (stale-anchor
 *     interleave safety).
 *   - `replaceRawBody` — rollback: FULL OVERWRITE (delete(0, len) +
 *     insert(0, raw)). The non-incremental replacement is the load-bearing
 *     signal to Y.UndoManager that "this is a rollback, not an edit";
 *     diff-based application would over-preserve Items the user explicitly
 *     rolled back.
 *
 * Atomicity boundary: NEITHER primitive calls `doc.transact()`. The caller
 * wraps so the per-session frozen origin object identity (precedent #24)
 * survives — Y.UndoManager's `trackedOrigins` Set membership relies on
 * object identity, not structural equality. A nested `doc.transact()` here
 * would lose origin identity.
 *
 * Y.Text is the source-of-truth for user-intended source bytes. Bytes that
 * enter via these primitives land verbatim, modulo only the equivalence
 * classes enumerated in `normalizeBridge` — and even those are TOLERATED at
 * compare time, never WRITTEN at apply time.
 */
import { applyFastDiff } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import { withSpanSync } from './telemetry.ts';

export interface PrecomputedParse {
  rawContent: string;
  parsedJson: JSONContent;
}

export type ComposeWriteSurface =
  | 'agent'
  | 'file-watcher'
  | 'managed-rename'
  | 'undo'
  | 'frontmatter';

/**
 * Apply raw composed bytes to Y.Text via an incremental line-aligned diff.
 *
 * MUST be called inside an outer `doc.transact(..., origin)` block
 * established by the caller (atomicity + per-session frozen origin object
 * identity per precedent #24).
 *
 * @param document Y.Doc holding the doc's `source` Y.Text.
 * @param rawContent Full document bytes (frontmatter + body) to write to Y.Text verbatim.
 */
export function composeAndWriteRawBody(
  document: Y.Doc,
  rawContent: string,
  surface: ComposeWriteSurface,
): void {
  withSpanSync(
    'bridge.composeAndWriteRawBody',
    {
      attributes: {
        surface,
        'body.bytes': rawContent.length,
        'doc.name': document.guid,
      },
    },
    () => {
      const ytext = document.getText('source');
      const currentYText = ytext.toString();
      if (currentYText !== rawContent) {
        applyFastDiff(ytext, currentYText, rawContent);
      }
    },
  );
}

/**
 * Replace Y.Text wholesale — the rollback semantics.
 *
 * MUST be called inside an outer `doc.transact(..., origin)` block
 * established by the caller (precedent #24).
 *
 * @param document Y.Doc holding the doc's `source` Y.Text.
 * @param rawContent Full document bytes (frontmatter + body) to write to Y.Text verbatim.
 */
export function replaceRawBody(document: Y.Doc, rawContent: string): void {
  withSpanSync(
    'bridge.replaceRawBody',
    {
      attributes: {
        'body.bytes': rawContent.length,
        'doc.name': document.guid,
      },
    },
    () => {
      const ytext = document.getText('source');
      const currentText = ytext.toString();
      if (currentText !== rawContent) {
        ytext.delete(0, currentText.length);
        ytext.insert(0, rawContent);
      }
    },
  );
}
