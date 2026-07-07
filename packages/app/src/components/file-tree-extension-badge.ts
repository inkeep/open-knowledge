/**
 * Pure DOM-mutation pass that renames Pierre's row label from
 * `[basename + hidden extension]` to `[basename without trailing dot] [badge]`.
 *
 * Pierre's `MiddleTruncate split="extension"` (see
 * `node_modules/@pierre/trees/dist/components/OverflowText.js`'s
 * `splitExtension`) places the leading dot of the extension in the BASENAME
 * segment, not the extension segment: `AGENTS.md` splits to `AGENTS.` + `md`.
 * Hiding the extension segment via CSS therefore leaves a trailing `.` on the
 * basename. This module repairs that artifact by trimming the trailing dot at
 * the text-node level, then (for non-`.md` files) injects an always-visible
 * uppercase badge as a sibling AFTER any decoration icons and BEFORE the
 * action ellipsis.
 *
 * Mutation-loop avoidance: every write is gated on a `current !== expected`
 * check. The host's `MutationObserver` fires on our own writes; the early
 * return keeps the observer self-quiescent. Pierre's re-renders overwrite
 * our mutations — the observer then re-applies them on the next tick.
 */

import { getFileExtension } from '@/components/file-tree-rename-validation';

export const OK_EXT_BADGE_ATTR = 'data-ok-ext-badge';
export const OK_EXT_ROW_ATTR = 'data-ok-ext-row';
// Marks folder rows recomposed to end-truncation (their dot-less name would
// otherwise center-split into two segments). See `applyFullNameEndTruncation`.
export const OK_FULLNAME_ROW_ATTR = 'data-ok-fullname-row';

/**
 * CSS rules that apply inside Pierre's shadow root. Passed alongside the
 * other `FILE_TREE_UNSAFE_CSS` rules in `FileTree.tsx`.
 *
 *   - Hide the extension `[data-truncate-segment-priority]:last-child` for
 *     rows the JS pass has classified as extension-bearing. CSS cannot
 *     distinguish `AGENTS.md` from `.gitignore` by path alone because Pierre
 *     splits dotfiles as `.` + `gitignore`; the row marker keeps hidden files
 *     readable when "All files" is enabled.
 *
 *   - Style the injected badge: small, muted, uppercase, never selectable
 *     or hover-targeted. Sits between the decoration lane and the action
 *     lane in flex flow.
 *
 *   - Re-target Pierre's per-extension markdown icon when the row is
 *     selected so it picks up `--trees-selected-fg` instead of staying gray.
 */
export const FILE_TREE_EXT_BADGE_CSS = `
  [data-item-selected='true'] [data-icon-token='markdown'] {
    color: var(--trees-selected-fg);
  }
  [data-type='item'][${OK_EXT_ROW_ATTR}] [data-truncate-segment-priority]:last-child {
    display: none;
  }
  [data-type='item'][${OK_FULLNAME_ROW_ATTR}] [data-truncate-segment-priority]:last-child {
    display: none;
  }
  [${OK_EXT_BADGE_ATTR}] {
    display: inline-block;
    margin-left: 0.375rem;
    margin-right: 0.25rem;
    align-self: center;
    color: color-mix(in oklab, var(--muted-foreground) 60%, transparent);
    font-size: 0.75rem;
    text-transform: uppercase;
    flex-shrink: 0;
    pointer-events: none;
    user-select: none;
  }
`;

/**
 * Trim trailing dots and inject/refresh extension badges across every row
 * under `root`. Idempotent — repeated calls with no DOM change are no-ops.
 *
 * Designed for invocation from a `MutationObserver` that watches Pierre's
 * shadow root. Callers may also invoke once on first paint.
 */
export function applyExtensionBadges(root: ParentNode): void {
  const rows = root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]');
  for (const row of rows) {
    const treePath = row.dataset.itemPath;
    if (!treePath) {
      clearExtensionRow(row);
      continue;
    }
    if (treePath.endsWith('/')) {
      // Folder: Pierre center-splits the (dot-less) name into two halves, which
      // renders as middle-truncation. Recompose to a single end-truncating
      // segment. Extensionless files keep Pierre's default — only folders were
      // the reported inconsistency vs. extension-bearing files.
      applyFullNameEndTruncation(row, treePath);
      continue;
    }
    const ext = getFileExtension(treePath);
    if (!ext) {
      clearExtensionRow(row);
      continue;
    }

    const basenameSeg = resolveBasenameSegment(row);
    if (!basenameSeg) continue;

    row.setAttribute(OK_EXT_ROW_ATTR, '');
    // A row can flip between ext-bearing and extensionless on rename; drop the
    // sibling marker so the two hide-rules never both apply.
    row.removeAttribute(OK_FULLNAME_ROW_ATTR);
    trimTrailingDotInBasenameSegment(basenameSeg);

    const isMarkdown = ext.toLowerCase() === '.md';
    if (isMarkdown) {
      removeStaleBadge(row);
      continue;
    }
    upsertBadge(row, ext.slice(1).toUpperCase());
  }
}

function removeStaleBadge(row: HTMLElement): void {
  const badge = row.querySelector<HTMLElement>(`[${OK_EXT_BADGE_ATTR}]`);
  if (badge) badge.remove();
}

function clearExtensionRow(row: HTMLElement): void {
  row.removeAttribute(OK_EXT_ROW_ATTR);
  row.removeAttribute(OK_FULLNAME_ROW_ATTR);
  removeStaleBadge(row);
}

/**
 * Pierre's leading (basename) truncate segment for a row, or null when the row
 * has no middle truncate group (a flattened breadcrumb renders
 * `[data-item-flattened-subitems]` instead) or its name wasn't center-split
 * into ≥2 segments (short names). Shared by the extension-badge path and the
 * folder end-truncation recompose, which both target this first segment.
 */
function resolveBasenameSegment(row: HTMLElement): HTMLElement | null {
  const truncateGroup = row.querySelector<HTMLElement>('[data-truncate-group-container="middle"]');
  if (!truncateGroup) return null;
  const segments = truncateGroup.querySelectorAll<HTMLElement>('[data-truncate-segment-priority]');
  if (segments.length < 2) return null;
  return segments[0] ?? null;
}

/**
 * Make a folder row end-truncate instead of middle-truncate. Pierre's
 * `MiddleTruncate split="extension"` finds no dot in a folder name and falls
 * back to a center split, rendering it as two halves (`open-` + `knowledge`)
 * that read as `open-…wledge`. Extension-bearing files avoid this because
 * hiding their trailing extension segment leaves the basename as a lone segment
 * that ellipsizes at its end. We reproduce that for folders: write the FULL
 * name into the first segment and hide the second (via `OK_FULLNAME_ROW_ATTR`),
 * so the row ellipsizes at the end (`open-knowl…`).
 *
 * Skips flattened breadcrumb rows (compact folders) — those render
 * `[data-item-flattened-subitems]` rather than a middle truncate group, so the
 * `truncateGroup` lookup misses and we leave them untouched. Idempotent: the
 * text write is gated on a value check, and the host `MutationObserver`
 * re-applies after each Pierre re-render (same contract as the badge pass).
 */
function applyFullNameEndTruncation(row: HTMLElement, treePath: string): void {
  // Not an extension row — clear the badge path's markers if this row used to
  // carry one (rename flip).
  row.removeAttribute(OK_EXT_ROW_ATTR);
  removeStaleBadge(row);

  // No middle truncate group (flattened breadcrumb) or a single segment (short
  // name Pierre didn't split) → resolveBasenameSegment returns null and there
  // is nothing to recompose.
  const basenameSeg = resolveBasenameSegment(row);
  const name = leafName(treePath);
  if (!basenameSeg || !name) {
    row.removeAttribute(OK_FULLNAME_ROW_ATTR);
    return;
  }

  setSegmentText(basenameSeg, name);
  row.setAttribute(OK_FULLNAME_ROW_ATTR, '');
}

/** Last path segment of a tree path, tolerating a trailing slash on folders. */
function leafName(treePath: string): string {
  const trimmed = treePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Apply `transform` to the first-child text node of every
 * `[data-truncate-content]` copy in a segment. Pierre's `Truncate` renders the
 * segment text twice — a visible copy and an aria-hidden overflow copy — so both
 * must move together to keep display and overflow-measurement in sync. Each
 * write is gated on a value change for MutationObserver quiescence (our own
 * writes re-trigger the host observer).
 */
function mapSegmentTextNodes(segment: HTMLElement, transform: (current: string) => string): void {
  const contentDivs = segment.querySelectorAll<HTMLElement>('[data-truncate-content]');
  for (const contentDiv of contentDivs) {
    const firstChild = contentDiv.firstChild;
    if (!firstChild || firstChild.nodeType !== Node.TEXT_NODE) continue;
    const current = firstChild.textContent ?? '';
    const next = transform(current);
    if (next !== current) firstChild.textContent = next;
  }
}

/** Overwrite a truncate segment's text (the folder end-truncation recompose). */
function setSegmentText(segment: HTMLElement, text: string): void {
  mapSegmentTextNodes(segment, () => text);
}

/**
 * Strip the trailing dot Pierre's `splitExtension` leaves on the basename
 * segment (`AGENTS.md` splits to `AGENTS.` + `md`). The value-gate inside
 * `mapSegmentTextNodes` makes this a no-op when there is no trailing dot.
 */
function trimTrailingDotInBasenameSegment(basenameSeg: HTMLElement): void {
  mapSegmentTextNodes(basenameSeg, (current) => current.replace(/\.+$/, ''));
}

/**
 * Inject (or update) the badge as a sibling RIGHT BEFORE the action lane
 * (the `···` context-menu trigger). DOM order ends up as:
 *   [basename text] [decoration?] [git?] [badge] [action ···]
 * Matching the requested ordering where decoration sits LEFT of badge.
 *
 * When no action lane exists, append to the row so the badge still lands
 * at the right edge of the label region.
 */
function upsertBadge(row: HTMLElement, label: string): void {
  let badge = row.querySelector<HTMLSpanElement>(`[${OK_EXT_BADGE_ATTR}]`);
  if (!badge) {
    badge = row.ownerDocument.createElement('span');
    badge.setAttribute(OK_EXT_BADGE_ATTR, '');
    badge.setAttribute('aria-hidden', 'true');
    const actionSection = row.querySelector('[data-item-section="action"]');
    if (actionSection) {
      actionSection.before(badge);
    } else {
      row.appendChild(badge);
    }
  }
  if (badge.textContent !== label) {
    badge.textContent = label;
  }
}
