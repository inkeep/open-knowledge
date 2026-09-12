/**
 * The two sibling write-side primitives for the Y.Text-is-truth contract (precedent #38):
 * `composeAndWriteRawBody` and `replaceRawBody`, each owning one paired-write semantics. No
 * primitive calls `doc.transact()`; the caller wraps.
 */
import { applyFastDiff } from '@inkeep/open-knowledge-core';
import type * as Y from 'yjs';
import { withSpanSync } from './telemetry.ts';

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
