import { plural, t } from '@lingui/core/macro';
import { filePathToDocName } from '@/lib/doc-hash';
import type { DocProblemCounts } from '@/lib/validation-store';

export const OK_PROBLEM_ROW_ATTR = 'data-ok-problem';
export const OK_PROBLEM_BADGE_ATTR = 'data-ok-problem-badge';

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
    /* No pointer-events: none. The badge is the row's problems control, so
       suppressing hit-testing would make it unclickable outright — and even
       before it was a control, the cursor fell through to the row and resolved
       the row's full-path title instead of the badge's own explanation. */
    user-select: none;
    color: var(--ok-tree-problem-warning, oklch(70% 0.15 75));
    background: color-mix(in oklab, currentColor 14%, transparent);
  }
  [data-type='item'][${OK_PROBLEM_ROW_ATTR}='error'] [${OK_PROBLEM_BADGE_ATTR}] {
    color: var(--ok-tree-problem-error, oklch(55% 0.15 25));
  }
  /* The painted chip is sized for a two-character count and lands ~24x16, under
     the 24x24 a pointer target owes. It cannot grow: the row is 26px and the
     digit has to stay beside the file name. So the TARGET grows instead of the
     chip, on the operable variant only — an inert badge is not a target and
     keeps its old footprint. Inset covers the row's full height, which also
     clears the 24px-diameter circle the spacing exception measures. */
  [${OK_PROBLEM_BADGE_ATTR}][role='button'] {
    position: relative;
  }
  [${OK_PROBLEM_BADGE_ATTR}][role='button']::after {
    content: '';
    position: absolute;
    inset: -5px -1px;
  }
  /* Under the pointer the chip is otherwise indistinguishable from the label it
     replaced: the row already sets a pointer cursor, so crossing into a
     sub-target that does something DIFFERENT from the row gives no signal at
     all. Stepping the tint up is the whole affordance, so it is a state change
     rather than a transition and has nothing for reduced motion to suppress. */
  @media (hover: hover) {
    [${OK_PROBLEM_BADGE_ATTR}][role='button']:hover {
      background: color-mix(in oklab, currentColor 28%, transparent);
    }
  }
  [${OK_PROBLEM_BADGE_ATTR}][role='button']:active {
    background: color-mix(in oklab, currentColor 38%, transparent);
  }
  /* The tree publishes its focus-ring tokens on the shadow host, so borrowing
     them keeps the badge's ring identical to a focused row's under either
     theme. Only width and color carry over: the tree's offset token is
     negative because a row paints its ring inset on a ::before, and inset on
     a chip this small would land the ring on top of the digit. */
  [${OK_PROBLEM_BADGE_ATTR}]:focus-visible {
    outline: var(--trees-focus-ring-width, 2px) solid
      var(--trees-focus-ring-color, currentColor);
    outline-offset: 1px;
  }
  /* Forced colors substitutes its own palette for the chip's translucent
     background, so a badge carrying meaning only in that background dissolves
     into the row and takes the error/warning distinction with it. A border in
     the system text color restores the chip as a shape, and severity rides its
     weight rather than a hue the palette refuses to honor. Same contract the
     drop-target affordances keep in FILE_TREE_UNSAFE_CSS. */
  @media (forced-colors: active) {
    [${OK_PROBLEM_BADGE_ATTR}] {
      border: 1px solid CanvasText;
    }
    [data-type='item'][${OK_PROBLEM_ROW_ATTR}='error'] [${OK_PROBLEM_BADGE_ATTR}] {
      border-width: 3px;
    }
  }
`;

export function applyProblemIndicators(
  root: ParentNode,
  counts: ReadonlyMap<string, DocProblemCounts>,
  onActivate?: (treePath: string, source: 'pointer' | 'keyboard') => void,
): void {
  const rows = root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]');
  for (const row of rows) {
    const treePath = row.dataset.itemPath;
    if (!treePath || treePath.endsWith('/')) {
      clearProblemIndicators(row);
      continue;
    }
    const docName = filePathToDocName(treePath);
    const entry = counts.get(docName);
    if (entry === undefined || (entry.errorCount === 0 && entry.warningCount === 0)) {
      clearProblemIndicators(row);
      continue;
    }
    const severity = entry.errorCount > 0 ? 'error' : 'warning';
    if (row.getAttribute(OK_PROBLEM_ROW_ATTR) !== severity) {
      row.setAttribute(OK_PROBLEM_ROW_ATTR, severity);
    }
    upsertProblemBadge(row, treePath, entry, onActivate);
  }
}

function clearProblemIndicators(row: HTMLElement): void {
  if (row.hasAttribute(OK_PROBLEM_ROW_ATTR)) row.removeAttribute(OK_PROBLEM_ROW_ATTR);
  const badge = row.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
  if (!badge) return;
  const treeRoot = row.getRootNode();
  if (treeRoot instanceof ShadowRoot && treeRoot.activeElement === badge) row.focus();
  badge.remove();
}

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

function problemBadgeAccessibleName(label: string, counts: DocProblemCounts): string {
  const total = counts.errorCount + counts.warningCount;
  const visibleSummary =
    total > 99 ? t`${label} problems` : plural(total, { one: '# problem', other: '# problems' });
  return t`${visibleSummary}. ${problemBadgeLabel(counts)}`;
}

function upsertProblemBadge(
  row: HTMLElement,
  treePath: string,
  counts: DocProblemCounts,
  onActivate?: (treePath: string, source: 'pointer' | 'keyboard') => void,
): void {
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
  const description = problemBadgeLabel(counts);
  const accessibleName = problemBadgeAccessibleName(label, counts);
  if (badge.getAttribute('aria-label') !== accessibleName) {
    badge.setAttribute('aria-label', accessibleName);
  }
  if (badge.title !== description) badge.title = description;
  applyBadgeActivation(badge, treePath, onActivate);
}

function applyBadgeActivation(
  badge: HTMLSpanElement,
  treePath: string,
  onActivate?: (treePath: string, source: 'pointer' | 'keyboard') => void,
): void {
  const role = onActivate === undefined ? 'img' : 'button';
  if (badge.getAttribute('role') !== role) badge.setAttribute('role', role);
  if (onActivate === undefined) {
    if (badge.hasAttribute('tabindex')) badge.removeAttribute('tabindex');
    badge.onclick = null;
    badge.onkeydown = null;
    return;
  }
  if (badge.getAttribute('tabindex') !== '0') badge.setAttribute('tabindex', '0');
  badge.onclick = (event) => {
    if (isModifiedActivation(event) || event.button !== 0) return;
    event.stopPropagation();
    onActivate(treePath, 'pointer');
  };
  badge.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (isModifiedActivation(event)) return;
    if (event.repeat) return;
    event.stopPropagation();
    event.preventDefault();
    onActivate(treePath, 'keyboard');
  };
}

function isModifiedActivation(event: MouseEvent | KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
