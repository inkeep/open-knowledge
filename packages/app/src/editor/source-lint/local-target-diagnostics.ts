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

type LinkFinding = ValidationDocResult['diagnostics'][number];

const OCCURRENCE_NODE_NAMES = new Set(['Link', 'Image', 'HTMLTag', 'HTMLBlock']);

const LOCAL_TARGET_MARK_CLASS = 'cm-lint-local-target';

function offsetOf(doc: Text, position: LintPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

function occurrenceSpan(state: EditorState, start: number): { from: number; to: number } {
  const tree = ensureSyntaxTree(state, start + 1, 100);
  if (tree) {
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

function toCmSeverity(severity: string): Diagnostic['severity'] {
  return severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warning';
}

export function mapLocalTargetDiagnostics(
  state: EditorState,
  findings: readonly LinkFinding[],
): Diagnostic[] {
  const doc = state.doc;
  const diagnostics: Diagnostic[] = [];
  for (const finding of findings) {
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

const refreshLocalTargetsEffect = StateEffect.define<null>();

export function createLocalTargetDiagnosticsExtension(docName: string): Extension {
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
        view.dispatch({ effects: refreshLocalTargetsEffect.of(null) });
        forceLinting(view);
      };
      const unsubscribe = subscribeToDocLinkFindings(docName, (state) => {
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
