/**
 * Cross-component "create a new file" trigger.
 *
 * The empty-state surface (`EmptyEditorState`'s primary "New file" /
 * "or start from scratch" CTAs + template picker) needs to invoke the
 * same flow the sidebar's `Create your first file` button uses — inline-
 * rename placeholder in the tree, busy-path tracking, navigation to the
 * new doc. That logic lives behind FileTree's imperative `startCreating` /
 * `createFromTemplate` handles, owned by `FileSidebar`. Rather than
 * thread refs through unrelated component boundaries, the empty state
 * emits a window-level `CustomEvent` and `FileSidebar` subscribes once.
 *
 * Mirrors the `documents-events.ts` pattern; same event-bus discipline.
 *
 * The event payload optionally carries:
 *   - `initialDir` — folder to create in. Empty string = project root.
 *     Absent treated as root (preserves the legacy "start at root" call).
 *   - `template` — when set, the FileTree's `createFromTemplate(folder, name)`
 *     path is used instead of the empty inline-rename path. `folder` is
 *     the template's `source_folder` (where the new doc lands).
 */

const CREATE_TOP_LEVEL_FILE_EVENT = 'open-knowledge:create-top-level-file';

export interface CreateFileRequest {
  /** Folder to create the file in. Empty string = project root. */
  initialDir?: string;
  /**
   * When set, scaffold from a template. `folder` is the template's
   * `source_folder` (the folder owning `.ok/templates/<name>.md`);
   * the new doc lands inside `folder`. `name` is the template's
   * filename without the `.md` extension.
   */
  template?: { folder: string; name: string };
}

export function emitCreateTopLevelFile(detail: CreateFileRequest = {}): void {
  window.dispatchEvent(new CustomEvent<CreateFileRequest>(CREATE_TOP_LEVEL_FILE_EVENT, { detail }));
}

export function subscribeToCreateTopLevelFile(
  onRequest: (request: CreateFileRequest) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CreateFileRequest | undefined>).detail;
    onRequest(detail ?? {});
  };
  window.addEventListener(CREATE_TOP_LEVEL_FILE_EVENT, listener);
  return () => window.removeEventListener(CREATE_TOP_LEVEL_FILE_EVENT, listener);
}
