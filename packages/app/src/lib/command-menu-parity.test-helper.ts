import { PALETTE_COMMANDS } from '@/components/command-palette-commands';

export const PALETTE_COMMAND_IDS = new Set<string>([
  ...PALETTE_COMMANDS.flatMap((cmd) => (cmd.menuActionId ? [cmd.menuActionId] : [])),
  'send-to-ai',
]);

export const APP_RESERVED_IDS = new Map<string, string>([
  ['delete', 'sidebar Trash id, distinct from the menu move-to-trash; not separately surfaced'],
  [
    'toggle-source',
    'view-in-source jump dispatched by the Desktop editor context menu; reachable there, not a Cmd+K palette row',
  ],
  ['save-version', 'deferred Project menu — not yet a shipped command anywhere'],
  ['version-history', 'deferred Project menu — not yet a shipped command anywhere'],
  ['focus-search', 'focus-routing id, not a user-facing command'],
  ['focus-command-palette', 'focus-routing id; self-referential inside the palette'],
]);

export const PRE_EXISTING_PALETTE_IDS = new Set<string>([
  'new-doc',
  'new-folder',
  'new-project',
  'send-to-ai',
  'report-bug',
  'send-feedback',
]);
