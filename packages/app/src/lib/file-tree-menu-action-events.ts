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
