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

import { plural, t } from '@lingui/core/macro';
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
    /* No pointer-events: none. The badge has to stay a hit target or the
       cursor falls through to the row and resolves the row's full-path
       title instead of the badge's own explanation. */
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
 * The badge's hover tooltip and accessible name. Names what the number counts
 * and where to act on it, because the digit alone reads as unexplained
 * decoration next to the file name.
 *
 * A function rather than a module constant: the macro at module scope would
 * resolve once at import and then keep whatever language was active then.
 */
function problemBadgeLabel(counts: DocProblemCounts): string {
  const errorCount = counts.errorCount;
  const warningCount = counts.warningCount;
  const errorText = plural(errorCount, { one: '# error', other: '# errors' });
  const warningText = plural(warningCount, { one: '# warning', other: '# warnings' });
  let summary: string;
  if (errorCount > 0 && warningCount > 0) {
    summary = t({
      message: `${errorText} and ${warningText}`,
      comment:
        'Joins the two counts in a file-tree problem tooltip. Reaches a translator as two placeholders and a conjunction, so: errorText is already pluralized ("2 errors"), warningText likewise ("1 warning"), and the result is the subject of the sentence that follows it.',
    });
  } else if (errorCount > 0) {
    summary = errorText;
  } else {
    summary = warningText;
  }
  return t`${summary} in this file. Open the Problems panel for details.`;
}

/**
 * Inject (or update) the count badge right before the action lane — the same
 * slot contract as the extension badge's `upsertBadge`, landing AFTER any
 * extension badge already in that position so the order reads
 * `[label] [decoration?] [EXT?] [count] [action ···]`.
 *
 * The badge sets its OWN `title`. FileTree stamps the full path as the row's
 * title, and a descendant only escapes that by carrying a title of its own.
 */
function upsertProblemBadge(row: HTMLElement, counts: DocProblemCounts): void {
  const total = counts.errorCount + counts.warningCount;
  const label = total > 99 ? '99+' : String(total);
  let badge = row.querySelector<HTMLSpanElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
  if (!badge) {
    badge = row.ownerDocument.createElement('span');
    badge.setAttribute(OK_PROBLEM_BADGE_ATTR, '');
    // A bare span's implicit role is `generic`, and ARIA 1.2 prohibits a name
    // on it, so browsers drop the aria-label below and announce only the
    // digit. `img` is on the name-from-author list, which is what makes the
    // accessible name reach a screen reader at all.
    badge.setAttribute('role', 'img');
    const actionSection = row.querySelector('[data-item-section="action"]');
    if (actionSection) {
      actionSection.before(badge);
    } else {
      row.appendChild(badge);
    }
  }
  if (badge.textContent !== label) badge.textContent = label;
  const description = problemBadgeLabel(counts);
  if (badge.getAttribute('aria-label') !== description) {
    badge.setAttribute('aria-label', description);
  }
  if (badge.title !== description) badge.title = description;
}
