import type { OkMenuAction } from './desktop-bridge-types';

/**
 * Runtime enumeration of every {@link OkMenuAction} id. TypeScript unions are
 * erased at runtime, so the command-parity ratchet needs this array to iterate
 * the id-space and assert each id is classified (palette command vs. reserved).
 *
 * Ratchet A (drift guard): `satisfies readonly OkMenuAction[]` rejects an id
 * here that is not in the union, and the `_MenuActionDrift` guard below rejects
 * a union member missing from this array — so adding an `OkMenuAction` without
 * listing it here fails to compile, and this array can never silently drift
 * from the type.
 */
export const OK_MENU_ACTIONS = [
  'new-doc',
  'new-folder',
  'new-project',
  'rename',
  'delete',
  'close-active-tab-or-window',
  'toggle-sidebar',
  'toggle-source',
  'save-version',
  'version-history',
  'focus-search',
  'focus-command-palette',
  'new-from-template',
  'duplicate',
  'move-to-trash',
  'reveal-in-finder',
  'send-to-ai',
  'copy-full-path',
  'copy-relative-path',
  'toggle-show-hidden-files',
  'toggle-show-ok-folders',
  'toggle-show-only-markdown-files',
  'toggle-show-skills-section',
  'expand-all-tree',
  'collapse-all-tree',
  'toggle-doc-panel',
  'toggle-terminal',
  'new-terminal',
  'kill-terminal',
  'new-worktree',
  'switch-worktree',
  'report-bug',
] as const satisfies readonly OkMenuAction[];

// Compile-time completeness: any OkMenuAction member missing from the array
// above resolves to a non-`never` type here, and assigning `true` to the
// resulting tuple type fails — so the typecheck gate goes red until the id is
// listed. (The reverse — an array entry that is not a real id — is caught by
// the `satisfies` clause.)
type _MenuActionDrift = Exclude<OkMenuAction, (typeof OK_MENU_ACTIONS)[number]>;
const _menuActionDriftGuard: [_MenuActionDrift] extends [never]
  ? true
  : ['OK_MENU_ACTIONS is missing an OkMenuAction id', _MenuActionDrift] = true;
void _menuActionDriftGuard;
