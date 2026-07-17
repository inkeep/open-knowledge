/**
 * Shared OkMenuAction classification for the command-palette / menu parity
 * ratchets. Lives in a test-helper (not a `.test.ts`) so the ratchet suite
 * (Ratchet A/B, `command-menu-parity.test.ts`) and the DOM render suite
 * (Ratchet C, `CommandPalette.dom.test.tsx`) consume ONE source of truth. That
 * shared list is what makes Ratchet C durable: a newly-classified palette id
 * with no rendered row (and not on the pre-existing escape hatch) turns the DOM
 * suite red instead of silently satisfying only the id-classification ratchets.
 */

// Ids reachable from Cmd+K after Phase 1 (backfilled or already present).
// `send-to-ai` is palette-present via the per-target Open-with-AI group.
export const PALETTE_COMMAND_IDS = new Set<string>([
  'new-doc',
  'new-folder',
  'new-project',
  'new-from-template',
  'rename',
  'duplicate',
  'move-to-trash',
  'reveal-in-finder',
  'send-to-ai',
  'copy-full-path',
  'copy-relative-path',
  'toggle-sidebar',
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
  'close-active-tab-or-window',
  'report-bug',
]);

// Ids deliberately NOT palette rows — each with a stated reason.
export const APP_RESERVED_IDS = new Map<string, string>([
  ['delete', 'sidebar Trash id, distinct from the menu move-to-trash; not separately surfaced'],
  ['toggle-source', 'source-mode toggle owned by the editor, not a palette action today'],
  ['save-version', 'deferred Project menu — not yet a shipped command anywhere'],
  ['version-history', 'deferred Project menu — not yet a shipped command anywhere'],
  ['focus-search', 'focus-routing id, not a user-facing command'],
  ['focus-command-palette', 'focus-routing id; self-referential inside the palette'],
]);

// Palette-command ids that reach Cmd+K through a PRE-EXISTING surface rather than
// a backfilled id-backed row, so they carry no `ID_BACKED` entry in the DOM
// suite. Each has its own rendered palette row/group (verified below), so Ratchet
// C treats them as covered:
//   new-doc     → the pre-existing "New file" row (testid command-palette-new-file)
//   new-folder  → the pre-existing "New folder" row
//   new-project → the pre-existing "New project" row
//   send-to-ai  → the per-target "Open with AI" group
//   report-bug  → the pre-existing "Report a Bug" row
export const PRE_EXISTING_PALETTE_IDS = new Set<string>([
  'new-doc',
  'new-folder',
  'new-project',
  'send-to-ai',
  'report-bug',
]);
