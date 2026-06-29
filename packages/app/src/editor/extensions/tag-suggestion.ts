
import type { Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { TagSuggestionMenu } from '../tag-suggestion/TagSuggestionMenu';
import { getEditorSourceMode } from './editor-mode-context';
import {
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from './suggestion-floating-ui';

export const tagSuggestionKey = new PluginKey('tagSuggestion');

export interface TagSummaryEntry {
  name: string;
  count: number;
  isLeaf: boolean;
}

export type TagSuggestionItem =
  | { kind: 'tag'; value: string; count: number; isLeaf: boolean }
  | { kind: 'create'; value: string };

const MAX_ITEMS = 8;

const TAG_VALID_RE = /^[a-zA-Z][\w/-]*$/;

export async function fetchTags(): Promise<TagSummaryEntry[]> {
  const r = await fetch('/api/tags');
  if (!r.ok) throw new Error(`/api/tags responded with ${r.status}`);
  const data: { tags?: TagSummaryEntry[] } = await r.json();
  return Array.isArray(data.tags) ? data.tags : [];
}

export function rankTagsByQuery(
  tags: readonly TagSummaryEntry[],
  query: string,
): TagSummaryEntry[] {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const filtered =
    trimmed === '' ? tags.slice() : tags.filter((t) => t.name.toLowerCase().includes(lower));
  filtered.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

export function buildTagSuggestionItems(
  tags: readonly TagSummaryEntry[],
  query: string,
): TagSuggestionItem[] {
  const ranked = rankTagsByQuery(tags, query);
  const items: TagSuggestionItem[] = ranked.slice(0, MAX_ITEMS).map((t) => ({
    kind: 'tag',
    value: t.name,
    count: t.count,
    isLeaf: t.isLeaf,
  }));

  const trimmed = query.trim();
  if (trimmed && TAG_VALID_RE.test(trimmed) && !tags.some((t) => t.name === trimmed)) {
    items.push({ kind: 'create', value: trimmed });
  }

  return items;
}

export function tagMatcher(config: {
  $position: ResolvedPos;
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const { $position } = config;
  const textBefore = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');

  const match = textBefore.match(/(^|[\s￼])#([a-zA-Z][\w/-]*)?$/);
  if (!match) return null;

  const query = match[2] ?? '';
  const blockStart = $position.start();
  const boundaryLen = match[1].length;
  const hashOffset = (match.index ?? 0) + boundaryLen;
  const triggerPos = blockStart + hashOffset;

  return {
    range: { from: triggerPos, to: $position.pos },
    query,
    text: `#${query}`,
  };
}

export function configureTagSuggestion(editor: Editor) {
  let cachedTags: TagSummaryEntry[] = [];
  let tagsLoaded = false;
  let tagsPromise: Promise<TagSummaryEntry[]> | null = null;
  let fetchError: string | null = null;

  return Suggestion<TagSuggestionItem>({
    editor,
    pluginKey: tagSuggestionKey,
    char: '#',
    allowedPrefixes: null,
    findSuggestionMatch: tagMatcher,
    allow: ({ editor }) => !getEditorSourceMode(editor),

    items: async ({ query }) => {
      if (!tagsLoaded) {
        tagsPromise ||= fetchTags();
        try {
          cachedTags = await tagsPromise;
          fetchError = null;
        } catch (err) {
          console.error('[tag-suggestion] Failed to fetch tags:', err);
          fetchError =
            'Failed to load tags. Press Escape and type # again to retry, or continue typing to create a new tag.';
          cachedTags = [];
        } finally {
          tagsLoaded = true;
          tagsPromise = null;
        }
      }
      return buildTagSuggestionItems(cachedTags, query);
    },

    command: ({ editor, range, props: item }) => {
      try {
        const value = item.value;
        if (!value || !TAG_VALID_RE.test(value)) return;
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({ type: 'tag', attrs: { value } })
          .insertContent(' ')
          .run();
      } catch (err) {
        console.error('[tag-suggestion] command failed', { item, range }, err);
      }
    },

    render: () => {
      let renderer: ReactRenderer<typeof TagSuggestionMenu> | null = null;
      let currentProps: SuggestionProps<TagSuggestionItem> | null = null;
      let selectedIndex = 0;
      const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };

      let doPosition: (() => void) | null = null;
      let reveal: (() => void) | null = null;

      const onSelect = (item: TagSuggestionItem) => {
        currentProps?.command(item);
      };

      const onHover = (index: number) => {
        if (selectedIndex === index) return;
        selectedIndex = index;
        rerender(null);
      };

      function computeMenuProps(
        props: SuggestionProps<TagSuggestionItem>,
        loadingOverride: boolean | null,
        onSelectCb: (item: TagSuggestionItem) => void,
      ) {
        const loading = loadingOverride !== null ? loadingOverride : !tagsLoaded;
        return {
          items: props.items,
          query: props.query ?? '',
          selectedIndex,
          onSelect: onSelectCb,
          onHover,
          loading,
          error: fetchError,
        };
      }

      const rerender = (loadingOverride: boolean | null) => {
        if (!renderer || !currentProps) return;
        renderer.updateProps(computeMenuProps(currentProps, loadingOverride, onSelect));
      };

      return {
        onBeforeStart(props: SuggestionProps<TagSuggestionItem>) {
          currentProps = props;
          selectedIndex = 0;

          const result = createSuggestionPopup(() => currentProps, 'tag-suggestion');
          posState.popup = result.popup;
          doPosition = result.doPosition;
          reveal = result.reveal;

          renderer = new ReactRenderer(TagSuggestionMenu, {
            props: computeMenuProps(props, true, onSelect),
            editor: props.editor,
          });
          result.popup.appendChild(renderer.element);
          posState.stopAutoUpdate = result.startAutoUpdate();
        },

        onStart(props: SuggestionProps<TagSuggestionItem>) {
          currentProps = props;
          selectedIndex = 0;
          rerender(null);
          reveal?.();
        },

        onUpdate(props: SuggestionProps<TagSuggestionItem>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
          rerender(null);
          doPosition?.();
        },

        onKeyDown({ event }: SuggestionKeyDownProps) {
          if (!currentProps) return false;
          const items = currentProps.items;

          if (event.key === 'ArrowDown') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex + 1) % items.length;
            rerender(null);
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (items.length === 0) return false;
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            rerender(null);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[selectedIndex];
            if (item) {
              currentProps.command(item);
              return true;
            }
            const trimmed = (currentProps.query ?? '').trim();
            if (trimmed && TAG_VALID_RE.test(trimmed)) {
              currentProps.command({ kind: 'create', value: trimmed });
              return true;
            }
            return false;
          }
          if (event.key === 'Escape') {
            return false;
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
          cachedTags = [];
          fetchError = null;
          tagsLoaded = false;
          tagsPromise = null;
        },
      };
    },
  });
}
