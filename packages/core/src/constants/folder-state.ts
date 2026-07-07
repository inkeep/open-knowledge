/**
 * Classification of a candidate folder path. Drives the renderer's banner
 * cascade and the IPC handler's defense-in-depth check.
 *
 *  - `'free'`             — path does not exist on disk; safe to mkdir.
 *  - `'exists-empty'`     — directory exists with zero entries; safe to use.
 *  - `'exists-nonempty'`  — directory exists with at least one entry, OR the
 *                           path resolves to a non-directory (a file occupies
 *                           the name). Either case blocks the create.
 */
export type OkFolderState = 'free' | 'exists-empty' | 'exists-nonempty';
