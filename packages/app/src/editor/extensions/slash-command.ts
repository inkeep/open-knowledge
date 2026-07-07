import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { filterItems, getSlashCommandItems, type SlashCommandItem } from '../slash-command/items';
import { SlashCommandMenu } from '../slash-command/SlashCommandMenu';
import { getEditorSourceMode } from './editor-mode-context';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from './suggestion-floating-ui';

const slashCommandKey = new PluginKey('slashCommand');

/**
 * Configuration options for the slash command extension.
 *
 * The slash command is pluggable — downstream branches can register additional
 * item sources and category labels without modifying this extension.
 */
export interface SlashCommandOptions {
  /**
   * Item source functions. Each is called on every trigger and its results
   * are merged into the menu. Default: `[getSlashCommandItems]` (the
   * built-in formatting items: headings, lists, quote, code, table, separator).
   *
   * Downstream consumers extend by passing additional sources via `.configure()`:
   *
   * ```ts
   * SlashCommand.configure({
   *   itemsSources: [getSlashCommandItems, () => getComponentItems()]
   * })
   * ```
   */
  itemsSources: (() => SlashCommandItem[])[];

  /**
   * Category labels to display in the menu. Defaults include:
   * - `basic` → "Basic blocks"
   * - `insert` → "Insert"
   *
   * Consumers can add labels for custom categories. TipTap's `configure()`
   * deep-merges plain objects, so existing labels are preserved automatically:
   *
   * ```ts
   * SlashCommand.configure({
   *   categoryLabels: { content: 'Content', layout: 'Layout' }
   * })
   * ```
   *
   * Note: `itemsSources` (an array) is *replaced* wholesale by `configure()`,
   * but `categoryLabels` (a plain object) is deep-merged.
   */
  categoryLabels: Record<string, string>;
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
        // Gate set inside @tiptap/suggestion's apply() reducer — when source
        // mode is active, the bridge still propagates the `/` keystroke into
        // the (CSS-hidden) WYSIWYG editor, but the plugin's `state.active`
        // stays false so onStart never fires and no popup is appended to
        // document.body. See `editor-mode-context.ts` for the signal.
        allow: ({ editor }) => !getEditorSourceMode(editor),
        // allowedPrefixes: [' '] is the default — accept it. Verified against
        // @tiptap/suggestion source (findSuggestionMatch): the prefix check uses
        // regex `^[<allowedPrefixes>\0]?$` against the char immediately before
        // the match position. Empty string (start-of-block) passes, space passes,
        // any other char fails. Note: @tiptap/suggestion accepts any
        // non-whitespace character after the trigger. Setting allowedPrefixes to
        // null would allow mid-word triggers like "hello/world" (regression).

        items: ({ query }) => {
          const allItems = extension.options.itemsSources.flatMap((source) => {
            try {
              return source();
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
          // Sort items so source order matches the visual (category-grouped)
          // order the menu renders. `SlashCommandMenu` groups items into
          // category buckets in first-appearance order and builds `indexMap`
          // from the flat source array — if those orders diverge, `selectedIndex`
          // (which advances through the source array) points to a button whose
          // DOM position differs from `selectedIndex`, so `data-selected=true`
          // lands on the wrong visual item. Category order is taken from
          // `categoryLabels` keys (declaration order); unknown categories
          // sort last. Stable sort preserves within-category source order.
          const categoryOrder = Object.keys(extension.options.categoryLabels);
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
          return filterItems(sorted, query);
        },

        command: ({ editor, range, props: item }) => {
          try {
            editor.chain().focus().deleteRange(range).run();
          } catch (err) {
            console.error(`[slash-command] deleteRange failed for "${item.name}"`, err);
            return;
          }
          try {
            item.command(editor);
          } catch (err) {
            console.error(`[slash-command] command "${item.name}" threw an error`, err);
          }
        },

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

              const result = createSuggestionPopup(() => currentProps, 'slash-command');
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
              // startAutoUpdate after content is in popup — autoUpdate fires
              // doPosition synchronously on setup, no separate doPosition() needed
              posState.stopAutoUpdate = result.startAutoUpdate();
              // Items are synchronous — reveal immediately. The popup becomes
              // visible after the first computePosition resolution.
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
              // Tab is an alias for Enter (intentional UX behavior — do not remove)
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = items[selectedIndex];
                if (item) currentProps.command(item);
                return true;
              }
              // Escape: @tiptap/suggestion calls onKeyDown but ignores the return
              // value, then always dispatches exit. This branch is explicit for
              // clarity — the return value has no effect.
              if (event.key === 'Escape') {
                return false;
              }
              return false;
            },

            onExit() {
              // Positioning cleanup first (stop autoUpdate → remove popup DOM)
              destroySuggestionPopup(posState);
              doPosition = null;
              // React cleanup last — if destroy() throws, DOM is already clean
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
