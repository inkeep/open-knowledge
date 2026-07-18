/**
 * Shared OkMenuAction classification for the command-palette / menu parity
 * ratchets. Lives in a test-helper (not a `.test.ts`) so the ratchet suite
 * (Ratchet A/B, `command-menu-parity.test.ts`) and the DOM render suite
 * (Ratchet C, `CommandPalette.dom.test.tsx`) consume ONE source of truth. That
 * shared list is what makes Ratchet C durable: a newly-classified palette id
 * with no rendered row (and not on the pre-existing escape hatch) turns the DOM
 * suite red instead of silently satisfying only the id-classification ratchets.
 */

import { PALETTE_COMMANDS } from '@/components/command-palette-commands';

// Ids reachable from Cmd+K — derived from the palette's command registry
// (every descriptor that declares a `menuActionId`), not a parallel
// hand-maintained list, so a registry row automatically classifies its id.
// `send-to-ai` is the one addition the registry cannot carry: it is
// palette-present via the bespoke per-target Open-with-AI group, which is not a
// fixed command row.
export const PALETTE_COMMAND_IDS = new Set<string>([
  ...PALETTE_COMMANDS.flatMap((cmd) => (cmd.menuActionId ? [cmd.menuActionId] : [])),
  'send-to-ai',
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

// Palette-command ids that reach Cmd+K through a surface other than a
// bus-dispatched registry row, so they carry no `ID_BACKED` entry in the DOM
// suite. Each has its own rendered palette row/group (verified there), so
// Ratchet C treats them as covered:
//   new-doc     → the registry "New file" row (opens NewItemDialog)
//   new-folder  → the registry "New folder" row (opens NewItemDialog)
//   new-project → the registry "New project" row (opens CreateProjectDialog)
//   send-to-ai  → the bespoke per-target "Open with AI" group
//   report-bug  → the registry "Report a bug" row (opens ReportBugDialog)
export const PRE_EXISTING_PALETTE_IDS = new Set<string>([
  'new-doc',
  'new-folder',
  'new-project',
  'send-to-ai',
  'report-bug',
]);
