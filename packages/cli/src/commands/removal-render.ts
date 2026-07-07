/**
 * Human + machine rendering for `ok deinit` / `ok uninstall` — grouped plan
 * output (rendered like `seed.ts`'s `formatPlanBody`) and the post-run outcome
 * summary, plus the `--json` shape.
 */

import { accent, dim, error as errorColor, success, warning } from '../ui/colors.ts';
import type { RemovalOp, RemovalOutcome, RemovalPlan } from './removal-plan.ts';

/** Group ops by their section, preserving first-seen order. */
function groupOps(ops: RemovalOp[]): Map<string, RemovalOp[]> {
  const groups = new Map<string, RemovalOp[]>();
  for (const op of ops) {
    const arr = groups.get(op.group) ?? [];
    arr.push(op);
    groups.set(op.group, arr);
  }
  return groups;
}

/** The confirmable plan body: each group's ops as a bulleted removal list. */
export function formatRemovalPlan(plan: RemovalPlan): string {
  if (plan.ops.length === 0) return dim('Nothing to remove.');
  const lines: string[] = [];
  for (const [group, ops] of groupOps(plan.ops)) {
    if (lines.length > 0) lines.push('');
    lines.push(accent(`${group}:`));
    for (const op of ops) {
      lines.push(`  ${warning('-')} ${op.label}`);
    }
  }
  return lines.join('\n');
}

/** Post-run summary: counts + every skipped/failed op with its reason. */
export function formatRemovalOutcome(outcome: RemovalOutcome): string {
  const removed = outcome.removed.length;
  const failed = outcome.failed.length;
  const notPresent = outcome.results.filter((r) => r.status === 'not-present').length;
  const skipped = outcome.results.filter((r) => r.status === 'skipped');

  const lines: string[] = [];
  lines.push(
    failed > 0
      ? warning(
          `Removed ${removed} item${removed === 1 ? '' : 's'}, ${failed} could not be removed.`,
        )
      : success(`✓ Removed ${removed} item${removed === 1 ? '' : 's'}.`),
  );
  if (notPresent > 0) lines.push(dim(`  ${notPresent} already absent.`));

  for (const s of skipped) {
    lines.push(
      `  ${warning('·')} Left in place: ${s.op.label}${s.detail ? ` — ${dim(s.detail)}` : ''}`,
    );
  }
  if (failed > 0) {
    lines.push('');
    lines.push(errorColor('Could not remove:'));
    for (const f of outcome.failed) {
      lines.push(`  ${errorColor('✗')} ${f.op.label}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

interface RemovalItem {
  kind: string;
  label: string;
  detail?: string;
}

/**
 * The `--json` shape. A `mode` discriminant keeps a dry-run PLAN (what WOULD be
 * removed, under `planned`) distinct from an applied OUTCOME (what actually
 * happened, under `removed`/`skipped`/`failed`) — so a consumer never confuses
 * "these are the ops I intend to run" with "these ops succeeded".
 */
export type RemovalJson =
  | { scope: 'uninstall' | 'deinit'; mode: 'dry-run'; planned: RemovalItem[] }
  | {
      scope: 'uninstall' | 'deinit';
      mode: 'applied';
      removed: RemovalItem[];
      skipped: RemovalItem[];
      failed: RemovalItem[];
    };

export function removalPlanToJson(plan: RemovalPlan): RemovalJson {
  return {
    scope: plan.scope,
    mode: 'dry-run',
    planned: plan.ops.map((op) => ({ kind: op.kind, label: op.label })),
  };
}

export function removalOutcomeToJson(
  scope: 'uninstall' | 'deinit',
  outcome: RemovalOutcome,
): RemovalJson {
  return {
    scope,
    mode: 'applied',
    removed: outcome.removed.map((r) => ({ kind: r.op.kind, label: r.op.label })),
    skipped: outcome.results
      .filter((r) => r.status === 'skipped')
      .map((r) => ({ kind: r.op.kind, label: r.op.label, detail: r.detail })),
    failed: outcome.failed.map((r) => ({ kind: r.op.kind, label: r.op.label, detail: r.detail })),
  };
}
