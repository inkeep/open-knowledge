/**
 * Source-mode target-existence diagnostics.
 *
 * The server owns the authoritative local-target assessment (documents,
 * ordinary files, images, and reference-style uses) and projects unresolved
 * occurrences onto the unified validation plane as `source: 'links'` findings,
 * already gated by the `validation.links` policy. This CodeMirror layer surfaces
 * those findings as `@codemirror/lint` diagnostics — the accessible source-mode
 * surface (gutter marker, hover message, keyboard-reachable lint panel) — one
 * per authored occurrence, at the occurrence position.
 *
 * Two source-mode concerns stay distinct: a **missing reference definition**
 * (`[text][ref]` with no `[ref]:` line) is a client-side syntax fact handled by
 * `source-polish/broken-ref-field`; a **definition whose destination is missing**
 * (`[ref]: ./missing.pdf`) is a target-existence fact the server assesses and
 * this layer reports at the use. They never fire on the same occurrence — an
 * unresolved reference use has no server occurrence to assess.
 *
 * The server collapses each finding's range to the occurrence start (the byte
 * offset every consumer navigates to). Here the point is widened to the
 * enclosing link/image span via the Lezer tree so the squiggle covers the whole
 * authored occurrence; the span is the client's responsive rendering while the
 * server remains the sole authority on whether the target exists (the client
 * cache never contradicts a settled assessment because this layer reads the
 * assessment, not the cache). No authored bytes are touched — diagnostics are
 * decorations over the raw source.
 */

import { ensureSyntaxTree } from '@codemirror/language';
import { type Diagnostic, forceLinting, linter } from '@codemirror/lint';
import { type EditorState, type Extension, StateEffect, type Text } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import type { LintPosition, ValidationDocResult } from '@inkeep/open-knowledge-core';
import {
  isLinkValidationVisible,
  subscribeToLinkValidationPolicy,
} from '../link-validation-policy';
import { localizedValidationMessage } from '../localized-validation-message';
import { subscribeToDocLinkFindings } from '../validation-audit-client';

/** Wire-loose diagnostic (schema `source`/`severity` are strings, by design). */
type LinkFinding = ValidationDocResult['diagnostics'][number];

/**
 * Lezer markdown node names whose span is the authored occurrence to underline.
 * `Link`/`Image` cover inline and reference-style markdown; `HTMLTag`/`HTMLBlock`
 * cover the bare and self-closing HTML `img` forms. Anything else (a wiki-link
 * node, or a position the parser has not reached) falls back to the point.
 */
const OCCURRENCE_NODE_NAMES = new Set(['Link', 'Image', 'HTMLTag', 'HTMLBlock']);

/** Selector hook so tests + any future styling can target this layer's ranges
 *  distinctly from markdownlint ranges (the severity class drives the visual). */
const LOCAL_TARGET_MARK_CLASS = 'cm-lint-local-target';

/**
 * Absolute CM offset for a 0-based LSP position, clamped: the doc can shift
 * between the async audit fetch and this mapping, so an out-of-range line/column
 * degrades to the nearest valid offset rather than throwing.
 */
function offsetOf(doc: Text, position: LintPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

/**
 * Widen the occurrence start to the enclosing link/image node's span. Returns a
 * zero-width span at `start` when no recognized node encloses it (wiki forms, or
 * a stale position after an edit) — still a positioned, accessible diagnostic.
 */
function occurrenceSpan(state: EditorState, start: number): { from: number; to: number } {
  const tree = ensureSyntaxTree(state, start + 1, 100);
  if (tree) {
    // `SyntaxNode` is declared but not exported by @codemirror/language, so the
    // walk type is taken from `resolveInner`'s own return rather than a named
    // import (avoids adding @lezer/common as a direct dependency).
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(start, 1);
    while (node) {
      if (OCCURRENCE_NODE_NAMES.has(node.name)) {
        return { from: node.from, to: node.to };
      }
      node = node.parent;
    }
  }
  return { from: start, to: start };
}

/** CodeMirror's severity scale admits `hint` too; the wire only ever carries
 *  these three. An unknown value degrades to `warning` rather than dropping. */
function toCmSeverity(severity: string): Diagnostic['severity'] {
  return severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warning';
}

/**
 * Project the server's `source: 'links'` findings onto CodeMirror diagnostics,
 * one per authored occurrence, each widened to its link/image span. Pure over
 * `(state, findings)` so it runs headless in tests.
 */
export function mapLocalTargetDiagnostics(
  state: EditorState,
  findings: readonly LinkFinding[],
): Diagnostic[] {
  const doc = state.doc;
  const diagnostics: Diagnostic[] = [];
  for (const finding of findings) {
    // Only link-plane findings carry a source occurrence; lint/frontmatter
    // findings belong to their own surfaces and are skipped here.
    if (finding.source !== 'links') continue;
    const start = offsetOf(doc, finding.range.start);
    const span = occurrenceSpan(state, start);
    diagnostics.push({
      from: span.from,
      to: Math.max(span.to, span.from),
      severity: toCmSeverity(finding.severity),
      message: localizedValidationMessage(finding),
      source: `${finding.source}/${finding.code}`,
      markClass: LOCAL_TARGET_MARK_CLASS,
    });
  }
  return diagnostics;
}

/**
 * `needsRefresh` marker: findings arrive asynchronously (audit fetch + CC1
 * `backlinks` pushes), not on doc edits, so a dispatched effect tells the lint
 * plugin to re-run this source when the doc is otherwise unchanged.
 */
const refreshLocalTargetsEffect = StateEffect.define<null>();

/**
 * Source-mode extension: a lint source reading the latest server findings, plus
 * a view plugin that fetches them for `docName` and re-fetches on every CC1
 * `backlinks` push (a target create/delete/rename ripples through the link
 * index). Composes with the markdownlint linter — `@codemirror/lint` merges all
 * lint sources into one diagnostic plane.
 */
export function createLocalTargetDiagnosticsExtension(docName: string): Extension {
  // Lives with the (cached, reparented) view rather than a React component, so
  // findings survive an Activity park/remount — mirrors the self-contained
  // markdown-lint-decorations pattern.
  const holder: { findings: readonly LinkFinding[] } = { findings: [] };
  return [
    linter(
      (view) =>
        isLinkValidationVisible() ? mapLocalTargetDiagnostics(view.state, holder.findings) : [],
      {
        delay: 300,
        needsRefresh: (update) =>
          update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(refreshLocalTargetsEffect)),
          ),
      },
    ),
    ViewPlugin.define((view) => {
      const apply = (findings: readonly LinkFinding[]): void => {
        holder.findings = findings;
        // Schedule (needsRefresh) then force it to run now: `forceLinting` alone
        // no-ops while the plugin is idle, so the dispatch primes it first.
        view.dispatch({ effects: refreshLocalTargetsEffect.of(null) });
        forceLinting(view);
      };
      const unsubscribe = subscribeToDocLinkFindings(docName, (state) => {
        // Preserve the last settled decorations while refreshing or degraded;
        // an empty/unavailable request must never paint a falsely-clean source.
        if (state.status === 'loaded') apply(state.findings);
      });
      const unsubscribePolicy = subscribeToLinkValidationPolicy(() => apply(holder.findings));
      return {
        destroy() {
          unsubscribe();
          unsubscribePolicy();
        },
      };
    }),
  ];
}
