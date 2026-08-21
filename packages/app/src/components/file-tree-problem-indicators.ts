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

/**
 * Tint + badge every file row whose doc has problems in `counts`; strip
 * indicators from rows that healed. Idempotent — repeated calls with no
 * change are no-ops. Folder rows are left untouched; only file rows carry
 * tint and a badge.
 */
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
  // A file can heal while its own badge holds focus (the audit that clears it
  // is asynchronous). Removing the focused element strands focus on the body,
  // so hand it back to the row the badge belonged to first.
  const treeRoot = row.getRootNode();
  if (treeRoot instanceof ShadowRoot && treeRoot.activeElement === badge) row.focus();
  badge.remove();
}

/**
 * The badge's hover tooltip and the tail of its accessible name. Names what the
 * number counts and where to act on it, because the digit alone reads as
 * unexplained decoration next to the file name. `problemBadgeAccessibleName`
 * prepends the painted count summary.
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

/** Accessible name whose opening text exactly matches the painted count. */
function problemBadgeAccessibleName(label: string, counts: DocProblemCounts): string {
  const total = counts.errorCount + counts.warningCount;
  const visibleSummary =
    total > 99 ? t`${label} problems` : plural(total, { one: '# problem', other: '# problems' });
  return t`${visibleSummary}. ${problemBadgeLabel(counts)}`;
}

/**
 * Inject (or update) the count badge right before the action lane — the same
 * slot contract as the extension badge's `upsertBadge`, landing AFTER any
 * extension badge already in that position so the order reads
 * `[label] [decoration?] [EXT?] [count] [action ···]`.
 *
 * The badge sets its OWN `title`. FileTree stamps the full path as the row's
 * title, and a descendant only escapes that by carrying a title of its own.
 *
 * With an `onActivate` the badge becomes an operable control; without one it
 * stays the inert indicator it is in any host that has nowhere to send the
 * activation, since a focusable control that does nothing is worse than a
 * label. Both roles are on the name-from-author list, so the accessible name
 * survives either way — which a bare span's implicit `generic` role would not,
 * ARIA 1.2 prohibiting a name on it.
 */
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

/**
 * Wire (or unwire) the badge as a control. Handlers are assigned to the event
 * PROPERTIES rather than added as listeners: the tree's MutationObserver
 * re-runs this whole pass whenever Pierre re-renders, and assignment replaces
 * where `addEventListener` would stack, so one click stays one activation no
 * matter how many passes ran. Property assignment is also invisible to that
 * observer, unlike the attribute writes, which stay value-gated.
 *
 * `tabindex="0"` diverges from the tree's roving-tabindex idiom, where the row
 * is the only tab stop and even the host's own in-row action affordance is
 * `aria-hidden` and untabbable. Nothing in the host routes a key press down to
 * a descendant, so the alternative is a control no keyboard can reach at all.
 * The added tab stops are bounded by the virtualized rows that actually carry
 * problems.
 */
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
    // A modified click is the tree's own multi-select gesture — the host reads
    // ctrl/meta/shift off it to extend or toggle the selection. The badge has
    // no modified meaning of its own, so it declines the event outright rather
    // than swallowing it: returning before `stopPropagation` is what leaves the
    // gesture intact for the row underneath.
    if (isModifiedActivation(event) || event.button !== 0) return;
    // The row resolves a plain click into its own selection + navigation. The
    // badge asks for something more specific about the same file, so it answers
    // for this click alone rather than letting both fire.
    event.stopPropagation();
    onActivate(treePath, 'pointer');
  };
  badge.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Same deference as the click: ctrl/meta + Space is the host's
    // toggle-selection chord, and it has to reach the row to mean anything.
    if (isModifiedActivation(event)) return;
    // A held key auto-repeats; a real button activates once, on release.
    if (event.repeat) return;
    event.stopPropagation();
    // Space would otherwise scroll the tree out from under the badge.
    event.preventDefault();
    onActivate(treePath, 'keyboard');
  };
}

/** Whether a modifier is held, i.e. the gesture belongs to the tree, not the badge. */
function isModifiedActivation(event: MouseEvent | KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
