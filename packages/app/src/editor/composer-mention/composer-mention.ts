import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';
import { type Editor, Extension, mergeAttributes, Node } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { history, redo, undo } from '@tiptap/pm/history';
import { keymap } from '@tiptap/pm/keymap';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { X } from 'lucide-react';
import { fileEntryPathIconToSvgString } from '@/components/file-entry-icon';
import { docNameToRelativePath } from '@/lib/workspace-paths';
import {
  clearSuggestionSelectableCount,
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
  setSuggestionSelectableCount,
} from '../extensions/suggestion-floating-ui';
import { fetchPages, filterPages, type PageItem } from '../extensions/wiki-link-suggestion';
import { lucideIconToSvgString } from '../registry/lucide-svg';
import { ComposerMentionMenu } from './ComposerMentionMenu';
import {
  ComposerCommand,
  ComposerSlashCommand,
  type SlashCommandItem,
} from './composer-slash-command';

export interface MentionItem {
  readonly docName: string;
  readonly title: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
}

const MAX_MENTION_ITEMS = 8;

export const composerMentionSuggestionKey = new PluginKey('composerMentionSuggestion');

export function pageItemToPath(item: PageItem): string {
  if (item.kind === 'asset') return item.docName.replace(/^\//, '');
  if (item.kind === 'folder') return item.docName;
  return docNameToRelativePath(item.docName);
}

const ComposerDoc = Node.create({ name: 'doc', topNode: true, content: 'paragraph+' });

const ComposerParagraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  parseHTML() {
    return [{ tag: 'p' }];
  },
  renderHTML() {
    return ['p', 0];
  },
});

const ComposerText = Node.create({ name: 'text', group: 'inline' });

const ComposerHardBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'br' }];
  },
  renderHTML() {
    return ['br'];
  },
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' }),
    };
  },
});

const ComposerHistory = Extension.create({
  name: 'composerHistory',
  addProseMirrorPlugins() {
    return [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo })];
  },
});

const ComposerMention = Node.create({
  name: 'composerMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: '' },
      label: { default: '' },
      mentionKind: { default: 'file' as const },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = String(node.attrs.label || node.attrs.path);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-mention': String(node.attrs.path ?? ''),
        class: 'composer-mention-chip',
      }),
      `@${label}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.path}`;
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const path = String(node.attrs.path ?? '');
      const fullLabel = String(node.attrs.label || node.attrs.path);

      const dom = document.createElement('span');
      dom.className = 'composer-mention-chip group/mention';
      dom.setAttribute('data-composer-mention', path);
      dom.title = fullLabel;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'composer-mention-icon';
      remove.setAttribute('aria-label', t`Remove ${fullLabel} from context`);

      const fileIcon = document.createElement('span');
      fileIcon.className = 'composer-mention-glyph composer-mention-glyph-icon';
      fileIcon.setAttribute('aria-hidden', 'true');
      fileIcon.innerHTML = fileEntryPathIconToSvgString(path);
      remove.appendChild(fileIcon);

      const xIcon = document.createElement('span');
      xIcon.className = 'composer-mention-glyph composer-mention-glyph-x';
      xIcon.setAttribute('aria-hidden', 'true');
      xIcon.innerHTML = lucideIconToSvgString(X);
      remove.appendChild(xIcon);

      remove.addEventListener('mousedown', (event) => event.preventDefault());
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run();
      });
      dom.appendChild(remove);

      const label = document.createElement('span');
      label.className = 'composer-mention-label';
      label.textContent = fullLabel;
      dom.appendChild(label);

      return { dom };
    };
  },

  addProseMirrorPlugins() {
    return [configureComposerMentionSuggestion(this.editor)];
  },
});

export function composerMentionExtensions(options?: {
  placeholder?: string;
  slashCommands?: SlashCommandItem[] | null;
}) {
  return [
    ComposerDoc,
    ComposerParagraph,
    ComposerText,
    ComposerHardBreak,
    ComposerHistory,
    ComposerMention,
    ComposerCommand,
    ...(options?.slashCommands !== undefined
      ? [ComposerSlashCommand.configure({ commands: options.slashCommands })]
      : []),
    ...(options?.placeholder
      ? [
          Placeholder.configure({
            placeholder: options.placeholder,
            showOnlyWhenEditable: false,
          }),
        ]
      : []),
  ];
}

export interface MentionCorpusSnapshot {
  readonly loaded: boolean;
  readonly error: boolean;
}

export function createMentionCorpus(
  fetch: () => Promise<PageItem[]> = () => fetchPages({ includeFolders: true }),
) {
  let cachedPages: PageItem[] = [];
  let pagesLoaded = false;
  let pagesPromise: Promise<PageItem[]> | null = null;
  let fetchError = false;

  return {
    snapshot(): MentionCorpusSnapshot {
      return { loaded: pagesLoaded, error: fetchError };
    },

    async getItems(query: string): Promise<MentionItem[]> {
      if (!pagesLoaded) {
        pagesPromise ||= fetch();
        try {
          cachedPages = await pagesPromise;
          pagesLoaded = true;
          fetchError = false;
        } catch (err) {
          console.error('[composer-mention] failed to fetch pages', err);
          cachedPages = [];
          fetchError = true;
        } finally {
          pagesPromise = null;
        }
      }
      return filterPages(cachedPages, query)
        .map((page) => ({
          docName: page.docName,
          title: page.title,
          path: pageItemToPath(page),
          kind: page.kind === 'folder' ? ('folder' as const) : ('file' as const),
        }))
        .filter((item) => item.path !== '');
    },

    reset() {
      cachedPages = [];
      pagesLoaded = false;
      pagesPromise = null;
      fetchError = false;
    },
  };
}

function configureComposerMentionSuggestion(editor: Editor) {
  const corpus = createMentionCorpus();

  return Suggestion<MentionItem>({
    editor,
    pluginKey: composerMentionSuggestionKey,
    char: '@',

    items: ({ query }) => corpus.getItems(query),

    command: ({ editor, range, props: item }) => {
      try {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent([
            {
              type: 'composerMention',
              attrs: { path: item.path, label: item.title, mentionKind: item.kind },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      } catch (err) {
        console.error('[composer-mention] insert failed', { item, range }, err);
      }
    },

    render: () => {
      let renderer: ReactRenderer<typeof ComposerMentionMenu> | null = null;
      let currentProps: SuggestionProps<MentionItem> | null = null;
      let selectedIndex = 0;
      const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };
      let doPosition: (() => void) | null = null;
      let reveal: (() => void) | null = null;
      let publishedView: object | null = null;

      const onSelect = (item: MentionItem) => {
        currentProps?.command(item);
      };

      const publishSelectableCount = (props: SuggestionProps<MentionItem>) => {
        publishedView = props.editor.view;
        setSuggestionSelectableCount(publishedView, (props.items ?? []).length);
      };

      const computeMenuProps = (props: SuggestionProps<MentionItem>) => {
        const items = props.items ?? [];
        const { loaded, error } = corpus.snapshot();
        return {
          items,
          query: props.query ?? '',
          selectedIndex,
          onSelect,
          loading: !loaded && !error,
          error,
          hasMore: items.length >= MAX_MENTION_ITEMS,
        };
      };

      const rerender = () => {
        if (!renderer || !currentProps) return;
        renderer.updateProps(computeMenuProps(currentProps));
      };

      return {
        onBeforeStart(props: SuggestionProps<MentionItem>) {
          currentProps = props;
          selectedIndex = 0;
          publishSelectableCount(props);
          const result = createSuggestionPopup(() => currentProps, 'composer-mention');
          posState.popup = result.popup;
          doPosition = result.doPosition;
          reveal = result.reveal;
          renderer = new ReactRenderer(ComposerMentionMenu, {
            props: computeMenuProps(props),
            editor: props.editor,
          });
          result.popup.appendChild(renderer.element);
          posState.stopAutoUpdate = result.startAutoUpdate();
        },

        onStart(props: SuggestionProps<MentionItem>) {
          currentProps = props;
          selectedIndex = 0;
          publishSelectableCount(props);
          rerender();
          reveal?.();
        },

        onUpdate(props: SuggestionProps<MentionItem>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
          publishSelectableCount(props);
          rerender();
          doPosition?.();
        },

        onKeyDown({ event }: SuggestionKeyDownProps) {
          if (!currentProps) return false;
          const items = currentProps.items;
          if (event.key === 'ArrowDown') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex + 1) % items.length;
            rerender();
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            rerender();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[selectedIndex];
            if (!item) return false;
            currentProps.command(item);
            return true;
          }
          return false;
        },

        onExit() {
          destroySuggestionPopup(posState);
          doPosition = null;
          reveal = null;
          renderer?.destroy();
          renderer = null;
          currentProps = null;
          selectedIndex = 0;
          if (publishedView !== null) {
            clearSuggestionSelectableCount(publishedView);
            publishedView = null;
          }
          corpus.reset();
        },
      };
    },
  });
}

export type ComposerAttachmentPart = Extract<AttachmentPart, { kind: 'file' | 'folder' }>;

export function serializeComposerContent(editor: Editor): {
  instruction: string;
  mentions: string[];
  attachments: ComposerAttachmentPart[];
} {
  const mentions: string[] = [];
  const attachments: ComposerAttachmentPart[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];

  editor.state.doc.forEach((block) => {
    let line = '';
    block.forEach((inline) => {
      if (inline.type.name === 'composerMention') {
        const path = String(inline.attrs.path ?? '');
        if (path !== '') {
          line += `@${path}`;
          if (!seen.has(path)) {
            seen.add(path);
            mentions.push(path);
            const label = String(inline.attrs.label ?? '');
            const kind =
              inline.attrs.mentionKind === 'folder' ? ('folder' as const) : ('file' as const);
            attachments.push({ kind, path, name: label !== '' ? label : path });
          }
        }
      } else if (inline.type.name === 'composerCommand') {
        line += `/${String(inline.attrs.name ?? '')}`;
      } else if (inline.isText) {
        line += inline.text ?? '';
      } else if (inline.type.name === 'hardBreak') {
        line += '\n';
      }
    });
    lines.push(line);
  });

  return { instruction: lines.join('\n').trim(), mentions, attachments };
}

export function isComposerEmpty(editor: Editor): boolean {
  const { instruction, mentions } = serializeComposerContent(editor);
  return instruction === '' && mentions.length === 0;
}
