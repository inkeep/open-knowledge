
import {
  getFileExtension,
  hasSupportedDocumentExtension,
} from '@/components/file-tree-rename-validation';

export const OK_RENAMING_ATTR = 'data-ok-renaming';
const RENAME_SELECTION_MARKER = 'data-ok-rename-selection-applied';

let activeRenameExt: string | null = null;
let activeRenameTimer: ReturnType<typeof setTimeout> | null = null;
const ACTIVE_RENAME_TIMEOUT_MS = 5_000;

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

export function applyRenameInputAffordance(root: ParentNode): void {
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
