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
