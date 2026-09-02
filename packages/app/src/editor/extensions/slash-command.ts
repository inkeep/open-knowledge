import { type Editor, Extension } from '@tiptap/core';
import { type EditorState, PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { applySlashCommandItem } from '../slash-command/apply-item';
import { filterItems, getSlashCommandItems, type SlashCommandItem } from '../slash-command/items';
import { SlashCommandMenu } from '../slash-command/SlashCommandMenu';
import { isSelectionInTableCell } from '../table-cell-context';
import { suggestionAllow } from './suggestion-allow';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from './suggestion-floating-ui';

const slashCommandKey = new PluginKey('slashCommand');

export interface SlashCommandOptions {
  itemsSources: ((ctx?: { editor?: Editor }) => SlashCommandItem[])[];

  categoryLabels: Record<string, string>;
}

export function buildSlashMenuItems(options: {
  sources: ((ctx?: { editor?: Editor }) => SlashCommandItem[])[];
  categoryOrder: string[];
  query: string;
  state: EditorState;
  editor?: Editor;
}): SlashCommandItem[] {
  const { sources, categoryOrder, query, state, editor } = options;
  const allItems = sources.flatMap((source) => {
    try {
      return source(editor !== undefined ? { editor } : undefined);
    } catch (err) {
      console.error('[slash-command] item source threw an error', err);
      return [];
    }
  });
  if (process.env.NODE_ENV !== 'production') {
    const seen = new Set<string>();
    for (const item of allItems) {
      if (seen.has(item.name)) {
        console.warn(
          `[slash-command] duplicate item name "${item.name}" — both will appear in the menu; ensure names are unique across sources`,
        );
      }
      seen.add(item.name);
    }
  }
  const indexOfCategory = (cat: string): number => {
    const i = categoryOrder.indexOf(cat);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const sorted = allItems
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const diff = indexOfCategory(a.item.category) - indexOfCategory(b.item.category);
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map((x) => x.item);
  const offerable = isSelectionInTableCell(state)
    ? sorted.filter((item) => !item.insertsBlockComponent)
    : sorted;
  return filterItems(offerable, query);
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      itemsSources: [getSlashCommandItems],
      categoryLabels: {
        basic: 'Basic blocks',
        insert: 'Insert',
      },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    return [
      Suggestion<SlashCommandItem>({
        editor: this.editor,
        pluginKey: slashCommandKey,
        char: '/',
        startOfLine: false,
        allow: suggestionAllow,

        items: ({ query, editor }) =>
          buildSlashMenuItems({
            sources: extension.options.itemsSources,
            categoryOrder: [
              ...new Set([
                'skills',
                'basic',
                'insert',
                ...Object.keys(extension.options.categoryLabels),
              ]),
            ],
            query,
            state: editor.state,
            editor,
          }),

        command: ({ editor, range, props: item }) => applySlashCommandItem({ editor, item, range }),

        render: () => {
          let renderer: ReactRenderer<typeof SlashCommandMenu> | null = null;
          let currentProps: SuggestionProps<SlashCommandItem> | null = null;
          let selectedIndex = 0;
          const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };

          let doPosition: (() => void) | null = null;

          const onHoverIndex = (idx: number) => {
            if (idx === selectedIndex) return;
            selectedIndex = idx;
            rerender();
          };

          const rerender = () => {
            if (!renderer || !currentProps) return;
            renderer.updateProps({
              items: currentProps.items,
              selectedIndex,
              categoryLabels: extension.options.categoryLabels,
              onSelect: currentProps.command,
              onHoverIndex,
            });
          };

          return {
            onStart(props: SuggestionProps<SlashCommandItem>) {
              currentProps = props;
              selectedIndex = 0;

              const result = createSuggestionPopup(() => currentProps, 'slash-command', {
                clipToEditorPane: true,
              });
              posState.popup = result.popup;
              doPosition = result.doPosition;

              renderer = new ReactRenderer(SlashCommandMenu, {
                props: {
                  items: props.items,
                  selectedIndex,
                  categoryLabels: extension.options.categoryLabels,
                  onSelect: props.command,
                  onHoverIndex,
                },
                editor: props.editor,
              });
              result.popup.appendChild(renderer.element);
              posState.stopAutoUpdate = result.startAutoUpdate();
              result.reveal();
            },

            onUpdate(props: SuggestionProps<SlashCommandItem>) {
              currentProps = props;
              selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
              rerender();
              doPosition?.();
            },

            onKeyDown({ event }: SuggestionKeyDownProps) {
              if (!currentProps || currentProps.items.length === 0) return false;
              const items = currentProps.items;

              if (event.key === 'ArrowDown') {
                selectedIndex = (selectedIndex + 1) % items.length;
                rerender();
                return true;
              }
              if (event.key === 'ArrowUp') {
                selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                rerender();
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = items[selectedIndex];
                if (item) currentProps.command(item);
                return true;
              }
              if (event.key === 'Escape') {
                return false;
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
            },
          };
        },
      }),
    ];
  },
});
