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

interface MenuActionEventDetail {
  readonly target: ResolvedNavigationTarget;
}

export function emitFileTreeMenuActionDelete(target: ResolvedNavigationTarget): void {
  window.dispatchEvent(
    new CustomEvent<MenuActionEventDetail>(FILE_TREE_MENU_ACTION_DELETE_EVENT, {
      detail: { target },
    }),
  );
}

export function subscribeToFileTreeMenuActionDelete(
  onRequest: (target: ResolvedNavigationTarget) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<MenuActionEventDetail>).detail;
    if (!detail?.target) return;
    onRequest(detail.target);
  };
  window.addEventListener(FILE_TREE_MENU_ACTION_DELETE_EVENT, listener);
  return () => window.removeEventListener(FILE_TREE_MENU_ACTION_DELETE_EVENT, listener);
}

export function emitFileTreeMenuActionRename(target: ResolvedNavigationTarget): void {
  window.dispatchEvent(
    new CustomEvent<MenuActionEventDetail>(FILE_TREE_MENU_ACTION_RENAME_EVENT, {
      detail: { target },
    }),
  );
}

export function subscribeToFileTreeMenuActionRename(
  onRequest: (target: ResolvedNavigationTarget) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<MenuActionEventDetail>).detail;
    if (!detail?.target) return;
    onRequest(detail.target);
  };
  window.addEventListener(FILE_TREE_MENU_ACTION_RENAME_EVENT, listener);
  return () => window.removeEventListener(FILE_TREE_MENU_ACTION_RENAME_EVENT, listener);
}

export function emitFileTreeMenuActionDuplicate(target: ResolvedNavigationTarget): void {
  window.dispatchEvent(
    new CustomEvent<MenuActionEventDetail>(FILE_TREE_MENU_ACTION_DUPLICATE_EVENT, {
      detail: { target },
    }),
  );
}

export function subscribeToFileTreeMenuActionDuplicate(
  onRequest: (target: ResolvedNavigationTarget) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<MenuActionEventDetail>).detail;
    if (!detail?.target) return;
    onRequest(detail.target);
  };
  window.addEventListener(FILE_TREE_MENU_ACTION_DUPLICATE_EVENT, listener);
  return () => window.removeEventListener(FILE_TREE_MENU_ACTION_DUPLICATE_EVENT, listener);
}
