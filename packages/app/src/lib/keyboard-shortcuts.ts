import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isMacOS } from '@tiptap/core';

export type ShortcutPlatform = 'mac' | 'windowsLinux';

export type ShortcutCategory =
  | 'general'
  | 'workspace'
  | 'search'
  | 'wysiwyg'
  | 'source'
  | 'navigation';

interface ShortcutMatchOptions {
  mod?: boolean;
  anyMod?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  allowShiftKey?: boolean;
  allowExtraModifiers?: boolean;
}

type ShortcutMatch = ShortcutMatchOptions &
  (
    | {
        key: string;
        code?: string;
      }
    | {
        key?: string;
        code: string;
      }
  );

interface PlatformShortcutMatches {
  mac?: ShortcutMatch;
  windowsLinux?: ShortcutMatch;
}

type PlatformShortcutMatch = ShortcutMatch | PlatformShortcutMatches;

export interface ShortcutBinding {
  mac: string;
  windowsLinux: string;
  match?: PlatformShortcutMatch;
}

export interface KeyboardShortcutDefinition {
  id: string;
  category: ShortcutCategory;
  title: MessageDescriptor;
  description: MessageDescriptor;
  scope: MessageDescriptor;
  bindings: ShortcutBinding[];
}

type ShortcutTargetLike =
  | EventTarget
  | { tagName?: string; isContentEditable?: boolean }
  | null
  | undefined;

export interface ShortcutEventLike {
  target?: ShortcutTargetLike;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  key: string;
  code?: string;
}

export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, MessageDescriptor> = {
  general: msg`General`,
  workspace: msg`Workspace`,
  search: msg`Search`,
  wysiwyg: msg`Visual editor`,
  source: msg`Source editor`,
  navigation: msg`Navigation and suggestions`,
};

export const SHORTCUT_CATEGORY_ORDER = Object.keys(SHORTCUT_CATEGORY_LABELS) as ShortcutCategory[];

const KEYBOARD_SHORTCUT_DEFINITIONS = [
  {
    // Exact ⌘K only (no extra-modifier tolerance) — a deliberate narrowing
    // that ships with the dual-role ⌘K: it keeps the add-link claim
    // unambiguous and frees ⌘⇧K (which would otherwise shadow CodeMirror's
    // delete-line in source mode). ⌘⇧K intentionally does NOT open the
    // palette; a regression test pins that.
    //
    // Phase-ordering contract for the shared ⌘K chord: this palette listener
    // is window BUBBLE phase; the add-link claim (LinkEditPopover) is window
    // CAPTURE phase and stops propagation when it applies. Any future
    // capture-phase ⌘K handler must slot into that ordering consciously —
    // the registry itself has no phase concept.
    id: 'command-palette',
    category: 'general',
    title: msg`Command palette`,
    description: msg`Search files, commands, projects, and AI handoff actions. With text selected in the visual editor, this chord adds a link instead.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌘ K',
        windowsLinux: 'Ctrl K',
        match: { key: 'k', mod: true },
      },
    ],
  },
  {
    id: 'settings',
    category: 'general',
    title: msg`Settings`,
    description: msg`Open this settings dialog.`,
    scope: msg`Global outside text fields`,
    bindings: [{ mac: '⌘ ,', windowsLinux: 'Ctrl ,', match: { key: ',', anyMod: true } }],
  },
  {
    id: 'new-item',
    category: 'general',
    title: msg`New file`,
    description: msg`Create a file from the current document or folder context.`,
    scope: msg`Global outside text fields`,
    bindings: [
      {
        mac: '⌘ N',
        windowsLinux: 'Ctrl N',
        match: { key: 'n', mod: true },
      },
      {
        mac: '⌥⌘ N',
        windowsLinux: 'Ctrl Alt N',
        match: { key: 'n', anyMod: true, altKey: true, allowExtraModifiers: true },
      },
    ],
  },
  {
    id: 'new-folder',
    category: 'general',
    title: msg`New folder`,
    description: msg`Create a folder from the current document or folder context.`,
    scope: msg`OK Desktop`,
    bindings: [{ mac: '⇧⌘ N', windowsLinux: 'Ctrl Shift N' }],
  },
  {
    id: 'toggle-files-sidebar',
    category: 'general',
    title: msg`Show or hide Files`,
    description: msg`Toggle the left file sidebar.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌥⌘ S',
        windowsLinux: 'Ctrl Alt S',
        match: { code: 'KeyS', anyMod: true, altKey: true, allowExtraModifiers: true },
      },
    ],
  },
  {
    id: 'toggle-document-panel',
    category: 'general',
    title: msg`Show or hide document panel`,
    description: msg`Toggle the right document panel.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌥⌘ B',
        windowsLinux: 'Ctrl Alt B',
        match: { code: 'KeyB', anyMod: true, altKey: true, allowExtraModifiers: true },
      },
    ],
  },
  {
    id: 'toggle-terminal-panel',
    category: 'general',
    title: msg`Show or hide terminal`,
    description: msg`Toggle the bottom terminal panel. With text selected, stage it in the terminal's AI input instead.`,
    scope: msg`OK Desktop`,
    bindings: [
      {
        mac: '⌘ J',
        windowsLinux: 'Ctrl J',
        match: { key: 'j', mod: true },
      },
    ],
  },
  {
    id: 'open-ask-ai',
    category: 'general',
    title: msg`Ask AI`,
    description: msg`Open and focus the bottom Ask AI prompt composer.`,
    scope: msg`OK Desktop`,
    bindings: [
      {
        mac: '⌘ L',
        windowsLinux: 'Ctrl L',
        match: { key: 'l', mod: true },
      },
    ],
  },
  {
    // Sibling of ⌘J: opens an additional terminal tab. With text selected, that
    // selection is staged into the new tab. The shift matcher keeps this clear
    // of the ⌘J toggle, whose matcher rejects shift.
    id: 'new-terminal-tab',
    category: 'general',
    title: msg`New terminal tab`,
    description: msg`Open an additional terminal tab. With text selected, stage it in the new tab's AI input.`,
    scope: msg`OK Desktop`,
    bindings: [
      {
        mac: '⇧⌘ J',
        windowsLinux: 'Ctrl Shift J',
        match: { key: 'j', mod: true, shiftKey: true },
      },
    ],
  },
  {
    id: 'tab-new',
    category: 'navigation',
    title: msg`New tab`,
    description: msg`Open a blank editor tab.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌘ T',
        windowsLinux: 'Ctrl T',
        match: { key: 't', mod: true },
      },
    ],
  },
  {
    id: 'tab-next',
    category: 'navigation',
    title: msg`Next tab`,
    description: msg`Activate the next editor tab.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌃ Tab',
        windowsLinux: 'Ctrl Tab',
        match: { key: 'Tab', ctrlKey: true },
      },
    ],
  },
  {
    id: 'tab-previous',
    category: 'navigation',
    title: msg`Previous tab`,
    description: msg`Activate the previous editor tab.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⌃⇧ Tab',
        windowsLinux: 'Ctrl Shift Tab',
        match: { key: 'Tab', ctrlKey: true, shiftKey: true },
      },
    ],
  },
  {
    id: 'tab-jump',
    category: 'navigation',
    title: msg`Jump to tab 1-8`,
    description: msg`Activate one of the first eight editor tabs.`,
    scope: msg`Global`,
    bindings: [{ mac: '⌘ 1-8', windowsLinux: 'Ctrl 1-8' }],
  },
  {
    id: 'tab-jump-last',
    category: 'navigation',
    title: msg`Jump to last tab`,
    description: msg`Activate the last editor tab.`,
    scope: msg`Global`,
    bindings: [{ mac: '⌘ 9', windowsLinux: 'Ctrl 9' }],
  },
  {
    id: 'tab-reopen-closed',
    category: 'navigation',
    title: msg`Reopen closed tab`,
    description: msg`Reopen the most recently closed editor tab.`,
    scope: msg`Global`,
    bindings: [
      {
        mac: '⇧⌘ T',
        windowsLinux: 'Ctrl Shift T',
        match: { key: 't', mod: true, shiftKey: true },
      },
    ],
  },
  {
    id: 'open-folder',
    category: 'workspace',
    title: msg`Open folder`,
    description: msg`Open an existing project folder from disk.`,
    scope: msg`OK Desktop`,
    bindings: [{ mac: '⌘ O', windowsLinux: 'Ctrl O' }],
  },
  {
    id: 'switch-project',
    category: 'workspace',
    title: msg`Switch project`,
    description: msg`Open the Project Navigator.`,
    scope: msg`OK Desktop`,
    bindings: [{ mac: '⇧⌘ P', windowsLinux: 'Ctrl Shift P' }],
  },
  {
    id: 'file-tree-copy',
    category: 'workspace',
    title: msg`Copy selected file or folder`,
    description: msg`Copy the focused file-tree item so Paste can duplicate it.`,
    scope: msg`Files sidebar`,
    bindings: [{ mac: '⌘ C', windowsLinux: 'Ctrl C' }],
  },
  {
    id: 'file-tree-paste',
    category: 'workspace',
    title: msg`Paste duplicate`,
    description: msg`Duplicate the file-tree item copied from the Files sidebar.`,
    scope: msg`Files sidebar`,
    bindings: [{ mac: '⌘ V', windowsLinux: 'Ctrl V' }],
  },
  {
    id: 'file-tree-duplicate',
    category: 'workspace',
    title: msg`Duplicate selected file or folder`,
    description: msg`Duplicate the focused file-tree item when focus is in the Files sidebar.`,
    scope: msg`Files sidebar`,
    bindings: [{ mac: '⌘ D', windowsLinux: 'Ctrl D' }],
  },
  {
    id: 'file-tree-delete',
    category: 'workspace',
    title: msg`Delete selected files or folders`,
    description: msg`Open delete confirmation for the selected file-tree items.`,
    scope: msg`Files sidebar`,
    bindings: [{ mac: '⌘ Backspace', windowsLinux: 'Delete' }],
  },
  {
    id: 'file-tree-select-all',
    category: 'workspace',
    title: msg`Select all files and folders`,
    description: msg`Select every visible file-tree row when focus is in the Files sidebar.`,
    scope: msg`Files sidebar`,
    bindings: [{ mac: '⌘ A', windowsLinux: 'Ctrl A' }],
  },
  {
    id: 'find',
    category: 'search',
    title: msg`Find`,
    description: msg`Open or close visual-editor find.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: '⌘ F', windowsLinux: 'Ctrl F', match: { key: 'f', mod: true, allowShiftKey: true } },
    ],
  },
  {
    id: 'replace',
    category: 'search',
    title: msg`Replace`,
    description: msg`Open visual-editor find with replace controls expanded.`,
    scope: msg`Visual editor`,
    bindings: [
      {
        mac: '⌥⌘ F',
        windowsLinux: 'Ctrl H',
        match: {
          mac: { key: 'f', mod: true, altKey: true },
          windowsLinux: { key: 'h', mod: true },
        },
      },
    ],
  },
  {
    id: 'find-next',
    category: 'search',
    title: msg`Find next match`,
    description: msg`Move to the next visual-editor find result.`,
    scope: msg`Visual editor find open`,
    bindings: [
      { mac: '⌘ G', windowsLinux: 'Ctrl G', match: { key: 'g', mod: true } },
      { mac: 'F3', windowsLinux: 'F3', match: { key: 'F3' } },
    ],
  },
  {
    id: 'find-previous',
    category: 'search',
    title: msg`Find previous match`,
    description: msg`Move to the previous visual-editor find result.`,
    scope: msg`Visual editor find open`,
    bindings: [
      { mac: '⇧⌘ G', windowsLinux: 'Ctrl Shift G', match: { key: 'g', mod: true, shiftKey: true } },
      { mac: 'Shift F3', windowsLinux: 'Shift F3', match: { key: 'F3', shiftKey: true } },
    ],
  },
  {
    id: 'find-field-navigation',
    category: 'search',
    title: msg`Find field navigation`,
    description: msg`Move through visual-editor find results from the find field.`,
    scope: msg`Visual editor find input focused`,
    bindings: [{ mac: 'Enter / Shift Enter', windowsLinux: 'Enter / Shift Enter' }],
  },
  {
    id: 'replace-current-from-field',
    category: 'search',
    title: msg`Replace current match from field`,
    description: msg`Replace the active match from the replace field.`,
    scope: msg`Visual editor replace input focused`,
    bindings: [{ mac: 'Enter', windowsLinux: 'Enter' }],
  },
  {
    id: 'format-bold',
    category: 'wysiwyg',
    title: msg`Bold`,
    description: msg`Toggle bold formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌘ B', windowsLinux: 'Ctrl B' }],
  },
  {
    id: 'format-italic',
    category: 'wysiwyg',
    title: msg`Italic`,
    description: msg`Toggle italic formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌘ I', windowsLinux: 'Ctrl I' }],
  },
  {
    id: 'format-underline',
    category: 'wysiwyg',
    title: msg`Underline`,
    description: msg`Toggle underline formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌘ U', windowsLinux: 'Ctrl U' }],
  },
  {
    id: 'format-strike',
    category: 'wysiwyg',
    title: msg`Strikethrough`,
    description: msg`Toggle strikethrough formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⇧⌘ X', windowsLinux: 'Ctrl Shift X' }],
  },
  {
    id: 'format-inline-code',
    category: 'wysiwyg',
    title: msg`Inline code`,
    description: msg`Toggle inline code formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌘ E', windowsLinux: 'Ctrl E' }],
  },
  {
    id: 'format-highlight',
    category: 'wysiwyg',
    title: msg`Highlight`,
    description: msg`Toggle highlight formatting.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⇧⌘ H', windowsLinux: 'Ctrl Shift H' }],
  },
  {
    // Same chord as `command-palette` by design: a capture-phase window
    // listener in the WYSIWYG bubble menu claims exact ⌘K first when a link
    // affordance applies (focused editor + text selection, or caret inside a
    // link); everywhere else the event falls through to the palette's
    // window-bubble listener.
    id: 'add-link',
    category: 'wysiwyg',
    title: msg`Add link`,
    description: msg`Link the selected text, or edit the link under the caret.`,
    scope: msg`Visual editor selection`,
    bindings: [
      {
        mac: '⌘ K',
        windowsLinux: 'Ctrl K',
        match: { key: 'k', mod: true },
      },
    ],
  },
  {
    id: 'edit-with-ai',
    category: 'general',
    title: msg`Ask AI (from selection)`,
    description: msg`Open and focus the Ask AI composer for the current editor selection.`,
    scope: msg`Editor selection`,
    bindings: [
      {
        mac: '⇧⌘ I',
        windowsLinux: 'Ctrl Shift I',
        match: { key: 'i', mod: true, shiftKey: true },
      },
    ],
  },
  {
    id: 'history-undo-redo',
    category: 'wysiwyg',
    title: msg`Undo or redo`,
    description: msg`Undo or redo visual-editor changes through TipTap collaboration history.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: '⌘ Z', windowsLinux: 'Ctrl Z' },
      { mac: '⇧⌘ Z / ⌘ Y', windowsLinux: 'Ctrl Shift Z / Ctrl Y' },
    ],
  },
  {
    id: 'heading-paragraph',
    category: 'wysiwyg',
    title: msg`Paragraph`,
    description: msg`Convert the current block to a paragraph.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌥⌘ 0', windowsLinux: 'Ctrl Alt 0' }],
  },
  {
    id: 'heading-levels',
    category: 'wysiwyg',
    title: msg`Heading levels`,
    description: msg`Toggle heading levels 1 through 6.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌥⌘ 1-6', windowsLinux: 'Ctrl Alt 1-6' }],
  },
  {
    id: 'list-bullet',
    category: 'wysiwyg',
    title: msg`Bullet list`,
    description: msg`Toggle a bullet list.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⇧⌘ 8', windowsLinux: 'Ctrl Shift 8' }],
  },
  {
    id: 'list-ordered',
    category: 'wysiwyg',
    title: msg`Ordered list`,
    description: msg`Toggle an ordered list.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⇧⌘ 7', windowsLinux: 'Ctrl Shift 7' }],
  },
  {
    id: 'list-task',
    category: 'wysiwyg',
    title: msg`Task list`,
    description: msg`Toggle a task list.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⇧⌘ 9', windowsLinux: 'Ctrl Shift 9' }],
  },
  {
    id: 'code-block',
    category: 'wysiwyg',
    title: msg`Code block`,
    description: msg`Toggle a fenced code block.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '⌥⌘ C', windowsLinux: 'Ctrl Alt C' }],
  },
  {
    id: 'hard-break',
    category: 'wysiwyg',
    title: msg`Hard break`,
    description: msg`Insert a markdown hard break.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: 'Shift Enter', windowsLinux: 'Shift Enter' },
      { mac: '⌘ Enter', windowsLinux: 'Ctrl Enter' },
    ],
  },
  {
    id: 'move-block',
    category: 'wysiwyg',
    title: msg`Move block`,
    description: msg`Move the current block up or down one position.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: '⇧⌘ ↑', windowsLinux: 'Ctrl Shift ↑' },
      { mac: '⇧⌘ ↓', windowsLinux: 'Ctrl Shift ↓' },
    ],
  },
  {
    id: 'list-indent',
    category: 'wysiwyg',
    title: msg`Indent or outdent list item`,
    description: msg`Indent or outdent the current list item.`,
    scope: msg`Visual editor list item`,
    bindings: [
      { mac: 'Tab', windowsLinux: 'Tab' },
      { mac: 'Shift Tab', windowsLinux: 'Shift Tab' },
    ],
  },
  {
    id: 'list-split-item',
    category: 'wysiwyg',
    title: msg`Split list item`,
    description: msg`Create a new list item from the current list item.`,
    scope: msg`Visual editor list item`,
    bindings: [{ mac: 'Enter', windowsLinux: 'Enter' }],
  },
  {
    id: 'table-cell-navigation',
    category: 'wysiwyg',
    title: msg`Move between table cells`,
    description: msg`Move to the next or previous table cell.`,
    scope: msg`Visual editor table`,
    bindings: [
      { mac: 'Tab', windowsLinux: 'Tab' },
      { mac: 'Shift Tab', windowsLinux: 'Shift Tab' },
    ],
  },
  {
    id: 'table-delete-selection',
    category: 'wysiwyg',
    title: msg`Delete selected table`,
    description: msg`Delete a table when the active table cell selection covers the full table.`,
    scope: msg`Visual editor table selection`,
    bindings: [
      { mac: 'Backspace / Delete', windowsLinux: 'Backspace / Delete' },
      { mac: '⌘ Backspace / ⌘ Delete', windowsLinux: 'Ctrl Backspace / Ctrl Delete' },
    ],
  },
  {
    id: 'delete-atom',
    category: 'wysiwyg',
    title: msg`Delete adjacent chip`,
    description: msg`Delete an adjacent wiki-link or tag chip.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: 'Backspace', windowsLinux: 'Backspace' },
      { mac: 'Delete', windowsLinux: 'Delete' },
    ],
  },
  {
    id: 'slash-menu',
    category: 'navigation',
    title: msg`Slash command menu`,
    description: msg`Open the insert menu in an empty or active text position.`,
    scope: msg`Visual editor`,
    bindings: [{ mac: '/', windowsLinux: '/' }],
  },
  {
    id: 'suggestion-navigation',
    category: 'navigation',
    title: msg`Suggestion menu navigation`,
    description: msg`Move through slash, wiki-link, tag, and path suggestions; accept or dismiss the active suggestion.`,
    scope: msg`Suggestion menu open`,
    bindings: [
      { mac: '↑ / ↓', windowsLinux: '↑ / ↓' },
      { mac: 'Enter / Tab', windowsLinux: 'Enter / Tab' },
      { mac: 'Esc', windowsLinux: 'Esc' },
    ],
  },
  {
    id: 'component-navigation',
    category: 'navigation',
    title: msg`Component boundary navigation`,
    description: msg`Select, enter, or leave block components and fallback source blocks from keyboard boundaries.`,
    scope: msg`Visual editor`,
    bindings: [
      { mac: '↑ / ↓ / ← / →', windowsLinux: '↑ / ↓ / ← / →' },
      { mac: 'Enter / Esc', windowsLinux: 'Enter / Esc' },
    ],
  },
  {
    id: 'source-indent',
    category: 'source',
    title: msg`Indent or outdent source`,
    description: msg`Indent or outdent source editor lines.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: 'Tab', windowsLinux: 'Tab' },
      { mac: 'Shift Tab', windowsLinux: 'Shift Tab' },
    ],
  },
  {
    id: 'source-navigation',
    category: 'source',
    title: msg`Source navigation and selection`,
    description: msg`Move the cursor or extend selection through CodeMirror's standard source-editor navigation keymap.`,
    scope: msg`Source editor`,
    bindings: [
      {
        mac: 'Arrow keys / Option Arrow / Command Arrow',
        windowsLinux: 'Arrow keys / Ctrl Arrow / Home / End',
      },
      { mac: 'Page Up / Page Down', windowsLinux: 'Page Up / Page Down' },
      { mac: 'Shift with movement keys', windowsLinux: 'Shift with movement keys' },
    ],
  },
  {
    id: 'source-editing',
    category: 'source',
    title: msg`Source editing`,
    description: msg`Insert, delete, move, copy, and indent source editor lines through CodeMirror's default keymap.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: 'Enter / Shift Enter / ⌘ Enter', windowsLinux: 'Enter / Shift Enter / Ctrl Enter' },
      { mac: 'Backspace / Delete', windowsLinux: 'Backspace / Delete' },
      { mac: '⌥ Backspace / ⌥ Delete', windowsLinux: 'Ctrl Backspace / Ctrl Delete' },
      { mac: '⌥ ↑ / ⌥ ↓', windowsLinux: 'Alt ↑ / Alt ↓' },
      { mac: '⇧⌥ ↑ / ⇧⌥ ↓', windowsLinux: 'Shift Alt ↑ / Shift Alt ↓' },
      { mac: '⇧⌘ K', windowsLinux: 'Ctrl Shift K' },
    ],
  },
  {
    id: 'source-history',
    category: 'source',
    title: msg`Source undo or redo`,
    description: msg`Undo, redo, or undo selection changes through CodeMirror history.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: '⌘ Z', windowsLinux: 'Ctrl Z' },
      { mac: '⇧⌘ Z', windowsLinux: 'Ctrl Y / Ctrl Shift Z' },
      { mac: '⌘ U / ⇧⌘ U', windowsLinux: 'Ctrl U / Alt U' },
    ],
  },
  {
    id: 'source-select-all',
    category: 'source',
    title: msg`Select all source`,
    description: msg`Select the full source document.`,
    scope: msg`Source editor`,
    bindings: [{ mac: '⌘ A', windowsLinux: 'Ctrl A' }],
  },
  {
    id: 'source-multi-cursor',
    category: 'source',
    title: msg`Source multi-cursor and multi-select`,
    description: msg`Add cursors or select matching occurrences through CodeMirror.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: '⌥⌘ ↑ / ⌥⌘ ↓', windowsLinux: 'Ctrl Alt ↑ / Ctrl Alt ↓' },
      { mac: '⇧⌘ L', windowsLinux: 'Ctrl Shift L' },
    ],
  },
  {
    id: 'source-search',
    category: 'source',
    title: msg`Source search`,
    description: msg`Open CodeMirror search in source editor mode.`,
    scope: msg`Source editor`,
    bindings: [{ mac: '⌘ F', windowsLinux: 'Ctrl F' }],
  },
  {
    id: 'source-toggle-comment',
    category: 'source',
    title: msg`Toggle source comment`,
    description: msg`Toggle a source comment through CodeMirror.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: '⌘ /', windowsLinux: 'Ctrl /' },
      { mac: 'Shift Alt A', windowsLinux: 'Shift Alt A' },
    ],
  },
  {
    id: 'source-select-next-occurrence',
    category: 'source',
    title: msg`Select next occurrence`,
    description: msg`Add the next matching source selection.`,
    scope: msg`Source editor`,
    bindings: [{ mac: '⌘ D', windowsLinux: 'Ctrl D' }],
  },
  {
    id: 'source-goto-line',
    category: 'source',
    title: msg`Go to line`,
    description: msg`Open CodeMirror's go-to-line prompt.`,
    scope: msg`Source editor`,
    bindings: [{ mac: '⌥⌘ G', windowsLinux: 'Ctrl Alt G' }],
  },
  {
    id: 'source-find-results',
    category: 'source',
    title: msg`Source find results`,
    description: msg`Navigate CodeMirror source search results or dismiss the search panel.`,
    scope: msg`Source editor search panel`,
    bindings: [
      { mac: '⌘ G / ⇧⌘ G', windowsLinux: 'Ctrl G / Ctrl Shift G' },
      { mac: 'F3 / Shift F3', windowsLinux: 'F3 / Shift F3' },
      { mac: 'Esc', windowsLinux: 'Esc' },
    ],
  },
  {
    id: 'source-folding',
    category: 'source',
    title: msg`Fold or unfold source`,
    description: msg`Fold, unfold, fold all, or unfold all source ranges.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: '⌥⌘ [ / ⌥⌘ ]', windowsLinux: 'Ctrl Shift [ / Ctrl Shift ]' },
      { mac: 'Ctrl Alt [ / Ctrl Alt ]', windowsLinux: 'Ctrl Alt [ / Ctrl Alt ]' },
    ],
  },
  {
    id: 'source-completion',
    category: 'source',
    title: msg`Start source completion`,
    description: msg`Open, navigate, accept, or dismiss CodeMirror completion suggestions.`,
    scope: msg`Source editor`,
    bindings: [
      { mac: 'Ctrl Space', windowsLinux: 'Ctrl Space' },
      { mac: '⌥ ` / ⌥ I', windowsLinux: 'Ctrl Space' },
      { mac: '↑ / ↓ / Page Up / Page Down', windowsLinux: '↑ / ↓ / Page Up / Page Down' },
      { mac: 'Enter / Esc', windowsLinux: 'Enter / Esc' },
    ],
  },
  {
    id: 'source-tab-focus-mode',
    category: 'source',
    title: msg`Toggle source tab focus mode`,
    description: msg`Let Tab leave the source editor instead of indenting.`,
    scope: msg`Source editor`,
    bindings: [{ mac: 'Shift Alt M', windowsLinux: 'Ctrl M' }],
  },
  {
    id: 'source-lint-panel',
    category: 'source',
    title: msg`Open source lint panel`,
    description: msg`Open CodeMirror's lint diagnostics panel.`,
    scope: msg`Source editor`,
    bindings: [{ mac: '⇧⌘ M', windowsLinux: 'Ctrl Shift M' }],
  },
  {
    id: 'source-next-diagnostic',
    category: 'source',
    title: msg`Next source diagnostic`,
    description: msg`Move to the next CodeMirror lint diagnostic.`,
    scope: msg`Source editor`,
    bindings: [{ mac: 'F8', windowsLinux: 'F8' }],
  },
] as const satisfies readonly KeyboardShortcutDefinition[];

export type KeyboardShortcutId = (typeof KEYBOARD_SHORTCUT_DEFINITIONS)[number]['id'];

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutDefinition[] =
  KEYBOARD_SHORTCUT_DEFINITIONS;

// Map lookup, not Array.find: `matchesKeyboardShortcut` callers include
// capture-phase window keydown listeners that run on every keypress.
const SHORTCUTS_BY_ID = new Map<KeyboardShortcutId, KeyboardShortcutDefinition>(
  KEYBOARD_SHORTCUT_DEFINITIONS.map((item) => [item.id, item]),
);

function getShortcut(id: KeyboardShortcutId): KeyboardShortcutDefinition {
  const shortcut = SHORTCUTS_BY_ID.get(id);
  if (!shortcut) throw new Error(`Unknown keyboard shortcut: ${id}`);
  return shortcut;
}

function currentShortcutPlatform(): ShortcutPlatform {
  return isMacOS() ? 'mac' : 'windowsLinux';
}

const SPOKEN_SHORTCUT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/⌘/g, ' Command '],
  [/⌥/g, ' Option '],
  [/⇧/g, ' Shift '],
  [/⌃/g, ' Control '],
  [/↑/g, ' Up Arrow '],
  [/↓/g, ' Down Arrow '],
  [/←/g, ' Left Arrow '],
  [/→/g, ' Right Arrow '],
  [/\[/g, ' Left Bracket '],
  [/\]/g, ' Right Bracket '],
  [/,/g, ' Comma '],
  [/\bCtrl\b/g, ' Control '],
];

export function formatShortcutTextLabel(shortcut: string): string {
  return shortcut
    .split(' / ')
    .map((part) =>
      SPOKEN_SHORTCUT_REPLACEMENTS.reduce(
        (label, [pattern, replacement]) => label.replace(pattern, replacement),
        part,
      )
        .replaceAll(/\s+/g, ' ')
        .trim(),
    )
    .join(' or ');
}

export function formatShortcutBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  return platform === 'mac' ? binding.mac : binding.windowsLinux;
}

export function formatShortcutBindingLabel(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  return formatShortcutTextLabel(formatShortcutBinding(binding, platform));
}

export function formatShortcut(
  id: KeyboardShortcutId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  return formatShortcutBinding(getShortcut(id).bindings[0], platform);
}

export function formatShortcutLabel(
  id: KeyboardShortcutId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  return formatShortcutBindingLabel(getShortcut(id).bindings[0], platform);
}

export function isEditableShortcutTarget(target: ShortcutTargetLike): boolean {
  if (!target || typeof target !== 'object') return false;
  if ('isContentEditable' in target && target.isContentEditable === true) return true;
  if (!('tagName' in target)) return false;
  const tagName = String(target.tagName).toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA';
}

export function matchesKeyboardShortcut(
  event: ShortcutEventLike,
  id: KeyboardShortcutId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): boolean {
  const shortcut = getShortcut(id);
  return shortcut.bindings.some((binding) => {
    const match = resolveMatch(binding.match, platform);
    return match ? matchesBinding(event, match, platform) : false;
  });
}

function resolveMatch(
  match: PlatformShortcutMatch | undefined,
  platform: ShortcutPlatform,
): ShortcutMatch | null {
  if (!match) return null;
  if (isShortcutMatch(match)) return match;
  return match[platform] ?? null;
}

function isShortcutMatch(match: PlatformShortcutMatch): match is ShortcutMatch {
  return 'key' in match || 'code' in match;
}

function matchesBinding(
  event: ShortcutEventLike,
  match: ShortcutMatch,
  platform: ShortcutPlatform,
): boolean {
  if (match.key && event.key.toLowerCase() !== match.key.toLowerCase()) return false;
  if (match.code && event.code !== match.code) return false;

  const expectedMeta = match.metaKey ?? (match.mod ? platform === 'mac' : false);
  const expectedCtrl = match.ctrlKey ?? (match.mod ? platform === 'windowsLinux' : false);
  const expectedAlt = match.altKey ?? false;
  const expectedShift = match.shiftKey ?? false;

  if (match.allowExtraModifiers) {
    if (match.anyMod && !event.metaKey && !event.ctrlKey) return false;
    if (expectedMeta && !event.metaKey) return false;
    if (expectedCtrl && !event.ctrlKey) return false;
    if (expectedAlt && !event.altKey) return false;
    if (expectedShift && !event.shiftKey) return false;
    return true;
  }

  const modMatches = match.anyMod
    ? event.metaKey || event.ctrlKey
    : event.metaKey === expectedMeta && event.ctrlKey === expectedCtrl;

  return (
    modMatches &&
    event.altKey === expectedAlt &&
    (match.allowShiftKey || Boolean(event.shiftKey) === expectedShift)
  );
}
