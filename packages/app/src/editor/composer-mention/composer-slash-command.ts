import { type Editor, Extension, mergeAttributes, Node } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { PluginKey, Plugin as PmPlugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import {
  clearSuggestionSelectableCount,
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
  setSuggestionSelectableCount,
} from '../extensions/suggestion-floating-ui';
import { ComposerSlashMenu } from './ComposerSlashMenu';

export interface SlashCommandItem {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string } | null;
}

export const composerSlashSuggestionKey = new PluginKey('composerSlashSuggestion');

export const ComposerCommand = Node.create({
  name: 'composerCommand',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      name: { default: '' },
      description: { default: '' },
      hint: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-command]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = String(node.attrs.name ?? '');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-command': name,
        class: 'composer-slash-token composer-slash-token-known',
      }),
      `/${name}`,
    ];
  },

  renderText({ node }) {
    return `/${node.attrs.name}`;
  },
});

const slashDecorationKey = new PluginKey<DecorationSet>('composerSlashToken');

const EXTENSION_NAME = 'composerSlashCommand';

interface SlashCommandOptions {
  commands: SlashCommandItem[] | null;
}

interface SlashCommandStorage {
  commands: SlashCommandItem[] | null;
}

function slashStorage(editor: Editor): SlashCommandStorage | undefined {
  return (editor.storage as unknown as Partial<Record<string, SlashCommandStorage>>)[
    EXTENSION_NAME
  ];
}

export function getSlashCommands(editor: Editor): SlashCommandItem[] | null {
  return slashStorage(editor)?.commands ?? null;
}

export function setSlashCommands(editor: Editor, commands: SlashCommandItem[] | null): boolean {
  const storage = slashStorage(editor);
  if (storage === undefined || storage.commands === commands) return false;
  storage.commands = commands;
  return true;
}

export function filterSlashCommands(
  commands: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...commands];
  const prefix: SlashCommandItem[] = [];
  const nameSub: SlashCommandItem[] = [];
  const descSub: SlashCommandItem[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) nameSub.push(command);
    else if (command.description.toLowerCase().includes(q)) descSub.push(command);
  }
  return [...prefix, ...nameSub, ...descSub];
}

export function leadingSlashToken(text: string): { name: string; length: number } | null {
  const match = /^\/(\S+)/.exec(text);
  if (match === null) return null;
  return { name: match[1] ?? '', length: match[0].length };
}

export type SlashTokenHint =
  | { kind: 'known'; name: string; description: string }
  | { kind: 'unknown'; name: string; agentHasCommands: boolean };

export function resolveSlashTokenHint(
  firstLineText: string,
  commands: readonly SlashCommandItem[] | null,
): SlashTokenHint | null {
  const token = leadingSlashToken(firstLineText);
  if (token === null || commands === null) return null;
  const command = commands.find((c) => c.name === token.name);
  if (command !== undefined) {
    return { kind: 'known', name: command.name, description: command.description };
  }
  return { kind: 'unknown', name: token.name, agentHasCommands: commands.length > 0 };
}

export function composerFirstLineText(editor: Editor): string {
  return leadingTextOfBlock(editor.state.doc.firstChild);
}

function leadingTextOfBlock(block: { firstChild: PmNode | null } | null): string {
  const inline = block?.firstChild ?? null;
  return inline?.isText ? (inline.text ?? '') : '';
}

function slashTokenDecorations(
  doc: Editor['state']['doc'],
  commands: SlashCommandItem[] | null,
): DecorationSet {
  const paragraph = doc.firstChild;
  const leadInline = paragraph?.firstChild ?? null;

  if (leadInline !== null && leadInline.type.name === 'composerCommand') {
    if (!draftIsBarePill(doc)) return DecorationSet.empty;
    const hint = String(leadInline.attrs.hint ?? '');
    const description = String(leadInline.attrs.description ?? '');
    const ghostText = hint !== '' ? hint : description !== '' ? `— ${description}` : '';
    if (ghostText === '') return DecorationSet.empty;
    return DecorationSet.create(doc, [
      ghostWidget(1 + (paragraph?.content.size ?? 0), ghostText, String(leadInline.attrs.name)),
    ]);
  }

  if (commands === null) return DecorationSet.empty;
  const token = leadingSlashToken(leadingTextOfBlock(doc.firstChild));
  if (token === null) return DecorationSet.empty;
  const command = commands.find((c) => c.name === token.name);
  const decorations: Decoration[] = [
    Decoration.inline(1, 1 + token.length, {
      class:
        command !== undefined
          ? 'composer-slash-token composer-slash-token-known'
          : 'composer-slash-token composer-slash-token-unknown',
    }),
  ];
  if (command !== undefined && draftIsBareCommand(doc, token.length)) {
    const ghostText =
      command.input?.hint != null && command.input.hint !== ''
        ? command.input.hint
        : `— ${command.description}`;
    if (command.description !== '' || command.input?.hint) {
      decorations.push(
        ghostWidget(1 + (doc.firstChild?.firstChild?.nodeSize ?? 0), ghostText, command.name),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

function ghostWidget(pos: number, ghostText: string, key: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement('span');
      span.className = 'composer-slash-ghost';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = ghostText;
      return span;
    },
    { side: 1, key: `slash-ghost:${key}` },
  );
}

function draftIsBareCommand(doc: Editor['state']['doc'], tokenLength: number): boolean {
  if (doc.childCount !== 1) return false;
  const paragraph = doc.firstChild;
  if (paragraph === null || paragraph.childCount !== 1) return false;
  const inline = paragraph.firstChild;
  if (inline === null || !inline.isText) return false;
  const text = inline.text ?? '';
  return text.length <= tokenLength + 1 && (text.length === tokenLength || text.endsWith(' '));
}

function draftIsBarePill(doc: Editor['state']['doc']): boolean {
  if (doc.childCount !== 1) return false;
  const paragraph = doc.firstChild;
  if (paragraph === null) return false;
  if (paragraph.childCount === 1) return true;
  if (paragraph.childCount !== 2) return false;
  const second = paragraph.child(1);
  return second.isText && /^\s*$/.test(second.text ?? '');
}

export const ComposerSlashCommand = Extension.create<SlashCommandOptions, SlashCommandStorage>({
  name: EXTENSION_NAME,

  addOptions() {
    return { commands: null };
  },

  addStorage() {
    return { commands: this.options.commands };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    const liveCommands = (): SlashCommandItem[] | null => storage.commands ?? null;

    const tokenPlugin = new PmPlugin<DecorationSet>({
      key: slashDecorationKey,
      state: {
        init: (_config, state) => slashTokenDecorations(state.doc, liveCommands()),
        apply: (tr) => slashTokenDecorations(tr.doc, liveCommands()),
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });

    const suggestion = Suggestion<SlashCommandItem>({
      editor: this.editor,
      pluginKey: composerSlashSuggestionKey,
      char: '/',
      startOfLine: true,
      allow: ({ range }) => range.from === 1,

      items: ({ query }) => {
        const commands = liveCommands();
        if (commands === null || commands.length === 0) return [];
        return filterSlashCommands(commands, query);
      },

      command: ({ editor, range, props: item }) => {
        const leading = editor.state.doc.firstChild?.firstChild ?? null;
        const tokenLength = leading?.isText
          ? (leadingSlashToken(leading.text ?? '')?.length ?? 0)
          : 0;
        try {
          editor
            .chain()
            .focus()
            .deleteRange({ from: range.from, to: Math.max(range.to, 1 + tokenLength) })
            .insertContent([
              {
                type: 'composerCommand',
                attrs: {
                  name: item.name,
                  description: item.description,
                  hint: item.input?.hint ?? '',
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        } catch (err) {
          console.error('[composer-slash-command] insert failed', { item, range }, err);
        }
      },

      render: () => {
        let renderer: ReactRenderer<typeof ComposerSlashMenu> | null = null;
        let currentProps: SuggestionProps<SlashCommandItem> | null = null;
        let selectedIndex = 0;
        const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };
        let doPosition: (() => void) | null = null;
        let publishedView: object | null = null;

        const onSelect = (item: SlashCommandItem) => {
          currentProps?.command(item);
        };

        const publishSelectableCount = (props: SuggestionProps<SlashCommandItem>) => {
          publishedView = props.editor.view;
          setSuggestionSelectableCount(publishedView, (props.items ?? []).length);
        };

        const computeMenuProps = (props: SuggestionProps<SlashCommandItem>) => ({
          items: props.items ?? [],
          query: props.query ?? '',
          selectedIndex,
          onSelect,
          commandsKnown: liveCommands() !== null,
        });

        const rerender = () => {
          if (!renderer || !currentProps) return;
          renderer.updateProps(computeMenuProps(currentProps));
        };

        return {
          onBeforeStart(props: SuggestionProps<SlashCommandItem>) {
            currentProps = props;
            selectedIndex = 0;
            publishSelectableCount(props);
            const result = createSuggestionPopup(() => currentProps, 'composer-slash');
            posState.popup = result.popup;
            doPosition = result.doPosition;
            renderer = new ReactRenderer(ComposerSlashMenu, {
              props: computeMenuProps(props),
              editor: props.editor,
            });
            result.popup.appendChild(renderer.element);
            posState.stopAutoUpdate = result.startAutoUpdate();
            result.reveal();
          },

          onStart(props: SuggestionProps<SlashCommandItem>) {
            currentProps = props;
            selectedIndex = 0;
            publishSelectableCount(props);
            rerender();
          },

          onUpdate(props: SuggestionProps<SlashCommandItem>) {
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
            renderer?.destroy();
            renderer = null;
            currentProps = null;
            selectedIndex = 0;
            if (publishedView !== null) {
              clearSuggestionSelectableCount(publishedView);
              publishedView = null;
            }
          },
        };
      },
    });

    return [tokenPlugin, suggestion];
  },
});
