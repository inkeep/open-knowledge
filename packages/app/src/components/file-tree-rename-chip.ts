/**
 * Adjusts Pierre's sidebar rename input after it mounts inside the open shadow
 * root. Pierre owns focus, value changes, blur-to-commit, and the `onRename`
 * event; this module only selects the editable filename stem while leaving the
 * extension visible and editable.
 *
 * Same shadow-root + MutationObserver pattern as `file-tree-extension-badge.ts`.
 * Verified against `@pierre/trees@1.0.0-beta.3`.
 *
 * **Pierre store reconciliation contract (load-bearing).** Pierre can still
 * commit an extensionless destination if the user deletes the suffix before
 * commit. React documents normalize to the canonical with-extension form, so
 * the two stores diverge — any later `model.resetPaths(canonicalPaths)` falls
 * back to index 0 because the extensionless key isn't in the canonical set.
 * Consumers MUST reconcile via `model.move(basename, canonical)` post-rename;
 * Pierre's `#applyMutationState` then remaps focus + selection atomically.
 */

import {
  getFileExtension,
  hasSupportedDocumentExtension,
} from '@/components/file-tree-rename-validation';

export const OK_RENAMING_ATTR = 'data-ok-renaming';
const RENAME_SELECTION_MARKER = 'data-ok-rename-selection-applied';

/**
 * Module-scope state of the in-flight extension-bearing rename. Set when the
 * rename input mounts; consulted on every subsequent observer tick
 * to apply the `data-ok-renaming` marker to the selected extensionless row
 * that Pierre's optimistic commit produces. The marker is intentionally not
 * set while the rename input is open because the canonical row already has
 * the correct icon. Cleared when no extensionless rows remain in the tree.
 *
 * Fallback timeout guarantees the flag drops even if the disk-truth refresh
 * never lands (network failure, server error) — without it, a stuck flag
 * would re-stamp unrelated extensionless files indefinitely.
 */
let activeRenameExt: string | null = null;
let activeRenameTimer: ReturnType<typeof setTimeout> | null = null;
const ACTIVE_RENAME_TIMEOUT_MS = 5_000;

/**
 * CSS rules that apply inside Pierre's shadow root. Concatenated into
 * `FILE_TREE_UNSAFE_CSS` in FileTree.tsx so a single `unsafeCSS` payload
 * keeps the cascade predictable.
 *
 * The CSS is limited to the transient markdown-icon overlay; selection
 * behavior is handled imperatively because Pierre renders the input inside a
 * shadow root.
 */
export const FILE_TREE_RENAME_INPUT_CSS = `
  /* Pierre's icon decoration keys off the row's data-item-path. If the user
     deletes the extension before commit, Pierre can temporarily key the row
     by an extensionless path and swap [data-icon-token] from 'markdown' to
     'default' until the disk-truth refresh restores .md.
     Cover the wrong icon with a CSS-rendered markdown glyph for the duration.
     applyRenameInputAffordance records the in-flight markdown extension when
     the input mounts; the sweep stamps the marker only if Pierre later moves
     the row to an extensionless path, then clears it when the path next
     includes the saved extension (settle / cancel / row recycle to a settled
     file). */
  [${OK_RENAMING_ATTR}='.md'] [data-item-section="icon"],
  [${OK_RENAMING_ATTR}='.mdx'] [data-item-section="icon"] {
    position: relative;
  }
  [${OK_RENAMING_ATTR}='.md'] [data-item-section="icon"] [data-icon-token]:not([data-icon-token='markdown']),
  [${OK_RENAMING_ATTR}='.mdx'] [data-item-section="icon"] [data-icon-token]:not([data-icon-token='markdown']) {
    visibility: hidden;
  }
  [${OK_RENAMING_ATTR}='.md'] [data-item-section="icon"]::before,
  [${OK_RENAMING_ATTR}='.mdx'] [data-item-section="icon"]::before {
    content: '';
    display: block;
    position: absolute;
    inset: 0;
    margin: auto;
    width: 16px;
    height: 16px;
    background-color: currentColor;
    mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M1 12V4h2l2 2.5L7 4h2v8H7V7.5l-2 2-2-2V12zm9-3 3 3.5L16 9h-2V4h-2v5z'/></svg>") center / contain no-repeat;
    pointer-events: none;
  }
`;

/**
 * Find the (zero-or-one) active rename input under `root` and select its
 * filename stem on first sight. Idempotent — repeated calls during the same
 * rename session are no-ops thanks to the `RENAME_SELECTION_MARKER` dataset
 * attribute on the input.
 *
 * Designed for invocation from a `MutationObserver` that watches Pierre's
 * shadow root for childList changes inside `[data-item-section="content"]`.
 */
export function applyRenameInputAffordance(root: ParentNode): void {
  // Phase 1 — sweep stale markers + maintain the in-flight overlay on the
  // selected extensionless row Pierre's optimistic commit produces. Runs
  // on every observer tick so the marker survives Pierre's row remount.
  syncRenameOverlay(root);

  const input = root.querySelector<HTMLInputElement>('[data-item-rename-input]');
  if (!input) return;
  const row = input.closest<HTMLElement>('[data-type="item"]');
  if (!row) return;

  const treePath = row.dataset.itemPath ?? '';
  if (treePath.endsWith('/')) return;
  const extension = getFileExtension(treePath);
  if (hasSupportedDocumentExtension(treePath)) setActiveRenameExt(extension);

  if (input.hasAttribute(RENAME_SELECTION_MARKER)) return;
  selectFilenameStem(input);
  input.setAttribute(RENAME_SELECTION_MARKER, '');
}

function setActiveRenameExt(ext: string): void {
  activeRenameExt = ext;
  if (activeRenameTimer !== null) clearTimeout(activeRenameTimer);
  activeRenameTimer = setTimeout(clearActiveRenameExt, ACTIVE_RENAME_TIMEOUT_MS);
}

function clearActiveRenameExt(): void {
  activeRenameExt = null;
  if (activeRenameTimer !== null) {
    clearTimeout(activeRenameTimer);
    activeRenameTimer = null;
  }
}

/** Test-only — reset the module's in-flight rename state so a fresh test
 *  starts from a known baseline. Not used at runtime. */
export function __resetRenameInputAffordanceForTesting(): void {
  clearActiveRenameExt();
}

/**
 * Per-tick overlay maintenance. Two concerns:
 *
 *   1. Stale-marker sweep — when a marked row's input is gone AND its path
 *      has the expected extension (settled / cancelled), or the path's
 *      extension diverges from the saved one (row recycled to an unrelated
 *      file), drop the marker. Without this, the CSS overlay would linger.
 *
 *   2. In-flight reapply — when `activeRenameExt` is set, find the selected
 *      extensionless row and stamp the marker. Scoped to
 *      `data-item-selected="true"` to avoid false positives on the legitimate
 *      extensionless files in the tree (`Makefile`, `Dockerfile`, README
 *      without extension, …).
 *
 * Clear `activeRenameExt` once no extensionless rows remain AND no rename
 * input is open — the disk-truth refresh has settled.
 */
function syncRenameOverlay(root: ParentNode): void {
  const markedRows = root.querySelectorAll<HTMLElement>(`[${OK_RENAMING_ATTR}]`);
  for (const row of markedRows) {
    if (row.querySelector('[data-item-rename-input]')) continue;
    const savedExt = row.getAttribute(OK_RENAMING_ATTR);
    if (!savedExt) {
      row.removeAttribute(OK_RENAMING_ATTR);
      continue;
    }
    const currentPath = row.dataset.itemPath ?? '';
    if (currentPath.toLowerCase().endsWith(savedExt.toLowerCase())) {
      row.removeAttribute(OK_RENAMING_ATTR);
      continue;
    }
    const currentExt = getFileExtension(currentPath);
    if (currentExt && currentExt.toLowerCase() !== savedExt.toLowerCase()) {
      row.removeAttribute(OK_RENAMING_ATTR);
    }
  }

  if (activeRenameExt === null) return;

  const rows = root.querySelectorAll<HTMLElement>('[data-type="item"][data-item-path]');
  let hasExtensionlessRow = false;
  for (const row of rows) {
    const path = row.dataset.itemPath ?? '';
    if (!path || path.endsWith('/')) continue;
    const ext = getFileExtension(path);
    if (!ext) {
      hasExtensionlessRow = true;
      if (
        row.getAttribute('data-item-selected') === 'true' &&
        row.getAttribute(OK_RENAMING_ATTR) !== activeRenameExt
      ) {
        row.setAttribute(OK_RENAMING_ATTR, activeRenameExt);
      }
    }
  }

  const hasOpenInput = !!root.querySelector('[data-item-rename-input]');
  if (!hasExtensionlessRow && !hasOpenInput) {
    clearActiveRenameExt();
  }
}

function selectFilenameStem(input: HTMLInputElement): void {
  const extension = getFileExtension(input.value);
  const selectionEnd = extension ? input.value.length - extension.length : input.value.length;
  input.setSelectionRange(0, selectionEnd);
}
