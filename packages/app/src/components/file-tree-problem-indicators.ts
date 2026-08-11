/**
 * Pure DOM-mutation pass that tints file-tree rows whose docs carry
 * validation problems (red for errors, yellow for warnings) and injects a
 * problem-count badge. Reads the shared validation store's snapshot; same
 * shadow-root + MutationObserver contract as `file-tree-extension-badge.ts`
 * (every write value-gated so the host observer stays self-quiescent).
 *
 * The count badge is a sibling of the extension badge (both can coexist on a
 * `.mdx` row) because the tree's single decoration lane is already taken by
 * the symlink / agent icons.
 *
 * Color plumbing: these rules name the tree-owned `--ok-tree-problem-*` pair,
 * which `globals.css` aliases at `:root` to the editor's theme-derived
 * `--lint-error-color` / `--lint-warning-color`. Custom properties inherit
 * through shadow boundaries, so that alias is what reaches this shadow root,
 * and both light and dark follow whichever theme resolved the lint tokens.
 * The `var()` fallback literals below only apply if the alias is missing.
 */

import { filePathToDocName } from '@/lib/doc-hash';
import type { DocProblemCounts } from '@/lib/validation-store';

export const OK_PROBLEM_ROW_ATTR = 'data-ok-problem';
export const OK_PROBLEM_BADGE_ATTR = 'data-ok-problem-badge';

/** CSS rules that apply inside Pierre's shadow root (joined into `FILE_TREE_UNSAFE_CSS`). */
export const FILE_TREE_PROBLEM_CSS = `
  [data-type='item'][${OK_PROBLEM_ROW_ATTR}='warning'] [data-item-section='content'] {
    color: var(--ok-tree-problem-warning, oklch(70% 0.15 75));
  }
  [data-type='item'][${OK_PROBLEM_ROW_ATTR}='error'] [data-item-section='content'] {
    color: var(--ok-tree-problem-error, oklch(55% 0.15 25));
  }
  [${OK_PROBLEM_BADGE_ATTR}] {
    display: inline-block;
    margin-left: 0.375rem;
    margin-right: 0.25rem;
    align-self: center;
    font-size: 0.6875rem;
    line-height: 1rem;
    min-width: 1rem;
    text-align: center;
    border-radius: 0.5rem;
    padding: 0 0.25rem;
    flex-shrink: 0;
    pointer-events: none;
    user-select: none;
    color: var(--ok-tree-problem-warning, oklch(70% 0.15 75));
    background: color-mix(in oklab, currentColor 14%, transparent);
  }
  [data-type='item'][${OK_PROBLEM_ROW_ATTR}='error'] [${OK_PROBLEM_BADGE_ATTR}] {
    color: var(--ok-tree-problem-error, oklch(55% 0.15 25));
  }
`;

/**
 * Tint + badge every file row whose doc has problems in `counts`; strip
 * indicators from rows that healed. Idempotent — repeated calls with no
 * change are no-ops. Folder rows are untouched (FR: files tint).
 */
export function applyProblemIndicators(
  root: ParentNode,
  counts: ReadonlyMap<string, DocProblemCounts>,
): void {
  const rows = root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]');
  for (const row of rows) {
    const treePath = row.dataset.itemPath;
    if (!treePath || treePath.endsWith('/')) {
      clearProblemIndicators(row);
      continue;
    }
    const entry = counts.get(filePathToDocName(treePath));
    if (entry === undefined || (entry.errorCount === 0 && entry.warningCount === 0)) {
      clearProblemIndicators(row);
      continue;
    }
    const severity = entry.errorCount > 0 ? 'error' : 'warning';
    if (row.getAttribute(OK_PROBLEM_ROW_ATTR) !== severity) {
      row.setAttribute(OK_PROBLEM_ROW_ATTR, severity);
    }
    upsertProblemBadge(row, entry);
  }
}

function clearProblemIndicators(row: HTMLElement): void {
  if (row.hasAttribute(OK_PROBLEM_ROW_ATTR)) row.removeAttribute(OK_PROBLEM_ROW_ATTR);
  row.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)?.remove();
}

/**
 * Inject (or update) the count badge right before the action lane — the same
 * slot contract as the extension badge's `upsertBadge`, landing AFTER any
 * extension badge already in that position so the order reads
 * `[label] [decoration?] [EXT?] [count] [action ···]`.
 */
function problemBadgeLabel(counts: DocProblemCounts): string {
  const total = counts.errorCount + counts.warningCount;
  const problems = total === 1 ? 'problem' : 'problems';
  const errors = counts.errorCount === 1 ? 'error' : 'errors';
  const warnings = counts.warningCount === 1 ? 'warning' : 'warnings';
  return `${total} ${problems}: ${counts.errorCount} ${errors}, ${counts.warningCount} ${warnings}`;
}

function upsertProblemBadge(row: HTMLElement, counts: DocProblemCounts): void {
  const total = counts.errorCount + counts.warningCount;
  const label = total > 99 ? '99+' : String(total);
  let badge = row.querySelector<HTMLSpanElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
  if (!badge) {
    badge = row.ownerDocument.createElement('span');
    badge.setAttribute(OK_PROBLEM_BADGE_ATTR, '');
    const actionSection = row.querySelector('[data-item-section="action"]');
    if (actionSection) {
      actionSection.before(badge);
    } else {
      row.appendChild(badge);
    }
  }
  if (badge.textContent !== label) badge.textContent = label;
  const accessibleLabel = problemBadgeLabel(counts);
  if (badge.getAttribute('aria-label') !== accessibleLabel) {
    badge.setAttribute('aria-label', accessibleLabel);
  }
}
