/**
 * Discriminator for the Navigator-side surface that initiated a project-open.
 *
 * Carried alongside every `openProject` call so the consent-dialog gate can
 * branch on user intent. `'create-new'` dispatches to the create-new-project
 * dialog flow (handled out-of-band via `ok:project:create-new`); every other
 * value either opens through the consent dialog (`'pick-existing'`,
 * `'recents'`, `'deep-link'`, `'drag-drop'`) or routes directly to an
 * already-discovered ancestor `.ok/` (`'create-new-nested-redirect'`, fired
 * by the create dialog's red-banner inline action). The folder's content
 * is irrelevant to the gate — only the user's gesture is.
 *
 * Pure type module — zero runtime dependencies. Imported by main, preload,
 * renderer, and utility process.
 */

export type EntryPoint =
  | 'create-new'
  | 'create-new-nested-redirect'
  | 'pick-existing'
  | 'recents'
  | 'deep-link'
  | 'drag-drop'
  | 'share-receive'
  // Opening a worktree of the current project. The
  // target is a linked worktree carrying the committed `.ok/config.yml`, so
  // `discoverProject` classifies it as `managed` and opens it directly with no
  // consent dialog. Tagged distinctly (like `recents`) so the ancestor-promote
  // toast is suppressed for this trusted-by-derivation open.
  | 'worktree';

const ENTRY_POINT_VALUES: ReadonlySet<EntryPoint> = new Set([
  'create-new',
  'create-new-nested-redirect',
  'pick-existing',
  'recents',
  'deep-link',
  'drag-drop',
  'share-receive',
  'worktree',
]);

/**
 * Runtime guard for the `EntryPoint` literal-union.
 *
 * The IPC channel `ok:project:open` accepts an arbitrary renderer-supplied
 * payload; type-only narrowing at the boundary doesn't survive the JSON hop.
 * Use this guard at every IPC boundary that consumes an `entryPoint` so a
 * malformed renderer can't drive the consent gate down an unintended branch.
 */
export function isEntryPoint(value: unknown): value is EntryPoint {
  return typeof value === 'string' && ENTRY_POINT_VALUES.has(value as EntryPoint);
}
