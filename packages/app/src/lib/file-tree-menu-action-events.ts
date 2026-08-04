/**
 * Cross-component "user picked a state-aware menu item that needs to act
 * on a FileTree-managed target" trigger.
 *
 * The macOS File menu's `move-to-trash`, `rename`, and `duplicate` items
 * need to invoke FileTree-owned spines (the 2-step Trash flow,
 * Pierre's inline-rename surface, and sidebar duplicate flow respectively),
 * but the menu handler lives in
 * `FileSidebarInner` (which holds the ambient `activeTarget` + the
 * `bridge.onMenuAction` subscription) while the spines live inside
 * `FileTree` (which owns the documents-state + tree-model + tab-close
 * orchestration + Pierre's `model.startRenaming(path)` API). Threading
 * callback refs through unrelated component boundaries would couple the
 * two for infrequent paths.
 *
 * Instead, the menu handler emits a window-level `CustomEvent` carrying
 * the active target's snapshot and FileTree subscribes once. Mirrors the
 * existing `create-file-events.ts` + `doc-panel-events.ts` patterns — same
 * event-bus discipline.
 *
 * The payload is the renderer's full `ResolvedNavigationTarget` (not the
 * narrowed `EditorActiveTargetSnapshot` main consumes) because FileTree
 * needs the full kind discriminator to compute `FileTreeTarget` correctly
 * (`folder-index` vs `folder`, `missing` short-circuit, etc.).
 */

import type { ResolvedNavigationTarget } from '@/components/navigation-targets';

const FILE_TREE_MENU_ACTION_DELETE_EVENT = 'open-knowledge:file-tree-menu-action-delete';
const FILE_TREE_MENU_ACTION_RENAME_EVENT = 'open-knowledge:file-tree-menu-action-rename';
const FILE_TREE_MENU_ACTION_DUPLICATE_EVENT = 'open-knowledge:file-tree-menu-action-duplicate';
const FILE_TREE_MENU_ACTION_IMPORT_TEMPLATE_EVENT =
  'open-knowledge:file-tree-menu-action-import-template';

interface MenuActionEventDetail {
  readonly target: ResolvedNavigationTarget;
}

interface RenameMenuActionEventDetail extends MenuActionEventDetail {
  readonly nextName?: string;
}

interface ImportTemplateMenuActionEventDetail extends MenuActionEventDetail {
  readonly deleteSource: boolean;
}

function emitMenuAction<T>(type: string, detail: T): void {
  window.dispatchEvent(new CustomEvent<T>(type, { detail }));
}

function subscribeToMenuAction<T extends MenuActionEventDetail>(
  type: string,
  onRequest: (detail: T) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<T>).detail;
    if (detail?.target) onRequest(detail);
  };
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}

export function emitFileTreeMenuActionDelete(target: ResolvedNavigationTarget): void {
  emitMenuAction(FILE_TREE_MENU_ACTION_DELETE_EVENT, { target });
}

export function subscribeToFileTreeMenuActionDelete(
  onRequest: (target: ResolvedNavigationTarget) => void,
): () => void {
  return subscribeToMenuAction(FILE_TREE_MENU_ACTION_DELETE_EVENT, ({ target }) =>
    onRequest(target),
  );
}

export function emitFileTreeMenuActionRename(
  target: ResolvedNavigationTarget,
  nextName?: string,
): void {
  emitMenuAction(FILE_TREE_MENU_ACTION_RENAME_EVENT, { target, nextName });
}

export function subscribeToFileTreeMenuActionRename(
  onRequest: (target: ResolvedNavigationTarget, nextName?: string) => void,
): () => void {
  return subscribeToMenuAction<RenameMenuActionEventDetail>(
    FILE_TREE_MENU_ACTION_RENAME_EVENT,
    ({ target, nextName }) => onRequest(target, nextName),
  );
}

export function emitFileTreeMenuActionDuplicate(target: ResolvedNavigationTarget): void {
  emitMenuAction(FILE_TREE_MENU_ACTION_DUPLICATE_EVENT, { target });
}

export function subscribeToFileTreeMenuActionDuplicate(
  onRequest: (target: ResolvedNavigationTarget) => void,
): () => void {
  return subscribeToMenuAction(FILE_TREE_MENU_ACTION_DUPLICATE_EVENT, ({ target }) =>
    onRequest(target),
  );
}

export function emitFileTreeMenuActionImportTemplate(
  target: ResolvedNavigationTarget,
  deleteSource: boolean,
): void {
  emitMenuAction(FILE_TREE_MENU_ACTION_IMPORT_TEMPLATE_EVENT, { target, deleteSource });
}

export function subscribeToFileTreeMenuActionImportTemplate(
  onRequest: (target: ResolvedNavigationTarget, deleteSource: boolean) => void,
): () => void {
  return subscribeToMenuAction<ImportTemplateMenuActionEventDetail>(
    FILE_TREE_MENU_ACTION_IMPORT_TEMPLATE_EVENT,
    ({ target, deleteSource }) => onRequest(target, deleteSource),
  );
}
