import type { OkMenuAction } from './desktop-bridge-types';

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
  'navigate-back',
  'navigate-forward',
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
  'move-terminal',
  'toggle-agent-panel',
  'new-terminal',
  'kill-terminal',
  'new-worktree',
  'switch-worktree',
  'report-bug',
  'send-feedback',
] as const satisfies readonly OkMenuAction[];

type _MenuActionDrift = Exclude<OkMenuAction, (typeof OK_MENU_ACTIONS)[number]>;
const _menuActionDriftGuard: [_MenuActionDrift] extends [never]
  ? true
  : ['OK_MENU_ACTIONS is missing an OkMenuAction id', _MenuActionDrift] = true;
void _menuActionDriftGuard;
