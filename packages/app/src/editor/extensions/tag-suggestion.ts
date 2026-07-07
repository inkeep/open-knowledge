/**
 * Tag suggestion plugin — `#` typeahead for inserting `tag` PM atoms.
 *
 * Mirrors the wiki-link `[[` plugin (`./wiki-link-suggestion.ts`):
 * `@tiptap/suggestion` Plugin + custom `findSuggestionMatch` + React-
 * rendered `TagSuggestionMenu`. Uses the same floating-ui popup helper
 * (`./suggestion-floating-ui.ts`) and the same hidden-then-reveal
 * pattern so the loading-state flash never measures at the wrong
 * position.
 *
 * Trigger semantics mirror `core/markdown/tag-promotion.ts`'s inline
 * boundary rule: `#` is a trigger only at start-of-block or after
 * whitespace. Matching `# ` (heading shortcut) does NOT trigger because
 * the regex requires the character after `#` to be either empty or a
 * valid first tag char (`[a-zA-Z]`); a space disqualifies. Matching
 * `abc#tag` (mid-word) does NOT trigger either because the regex
 * requires whitespace or paragraph-start before the `#`.
 *
 * The trigger query is the bare tag value (without the `#`), so the
 * `TagIndex` API contract (`/api/tags`) and the PM `tag` atom's `value`
 * attribute share the same shape.
 *
 * Tags are case-sensitive (matches Obsidian + the server-side
 * `TagIndex`). Filter is case-INsensitive substring with prefix-first
 * ranking + count-desc tiebreak — same UX Obsidian's `#` typeahead
 * uses. The "create new tag" item appears when the typed query is a
 * valid tag name (`/^[a-zA-Z][\w/-]*$/`, mirroring the parser regex)
 * AND no existing tag in the index matches it exactly.
 */

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

/**
 * Mirror of `tag-promotion.ts`'s inline-tag value pattern: starts with a
 * letter, continues with word chars, slashes, or hyphens. Used to gate
 * the "create new tag" affordance — typing `#9foo` or `#-bar` should
 * NOT surface a "Create" row because the parser would reject those
 * inputs on save.
 */
const TAG_VALID_RE = /^[a-zA-Z][\w/-]*$/;

/**
 * Fetch the workspace tag summary list. Single source of truth for
 * `/api/tags` consumption in the app — both the editor's `#`
 * typeahead (this module) and the command palette's `tag:` filter
 * (`command-palette-tag-search.ts`) call this. Sister to
 * `wiki-link-suggestion.ts`'s `fetchPages` (also exported, also
 * single-source).
 */
export async function fetchTags(): Promise<TagSummaryEntry[]> {
  const r = await fetch('/api/tags');
  if (!r.ok) throw new Error(`/api/tags responded with ${r.status}`);
  const data: { tags?: TagSummaryEntry[] } = await r.json();
  return Array.isArray(data.tags) ? data.tags : [];
}

/**
 * Ranking algorithm used by both the inline `#` typeahead and the
 * command palette's `tag:` picker — exported so the two surfaces
 * share one definition of "best match" instead of drifting.
 *
 * Filter: case-insensitive substring match against the trimmed query
 * (empty query returns every tag).
 *
 * Sort (descending priority):
 *   1. Tags whose name STARTS WITH the query come before substring-
 *      only matches.
 *   2. Within each tier, higher `count` wins.
 *   3. Tiebreak by alphabetical name.
 *
 * Returns a NEW sorted array — input is never mutated.
 */
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

/**
 * Editor-surface presentation: rank tags via the shared
 * `rankTagsByQuery`, cap at MAX_ITEMS for the floating popover's
 * limited vertical space, and append a "create new tag" affordance
 * (below the existing-tag matches) when the query is a valid tag name
 * not yet in the index.
 *
 * The "create" check uses the FULL tag list (case-sensitive equality)
 * — tags themselves are case-sensitive (`Project` and `project` are
 * distinct in the index), so offering "Create #Project" when
 * `project` exists is correct (creates a sibling, which is what the
 * user wants).
 */
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

/**
 * Custom `findSuggestionMatch` for `@tiptap/suggestion`. Triggers on
 * `#` at start-of-block or after whitespace, with optional valid
 * tag-name body. Returns null otherwise — including for `# ` (heading
 * shortcut) and `abc#foo` (mid-word).
 *
 * Pure function — exported for unit testing the boundary semantics
 * without a live editor.
 */
export function tagMatcher(config: {
  $position: ResolvedPos;
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const { $position } = config;
  const textBefore = $position.parent.textBetween(0, $position.parentOffset, undefined, '￼');

  // Match `(boundary)#(body)` at end-of-input. Boundary is start-of-text
  // OR a whitespace / atom-leaf (`￼` is the object-replacement char
  // `textBetween` substitutes for inline atoms). Body is empty (just
  // typed `#`) OR a valid tag-name continuation.
  //
  // The trailing space disqualifier is implicit: a space after `#`
  // wouldn't be captured by `[\w/-]*` and would push `$` past the body
  // group, failing the match. That's the heading-shortcut guard.
  const match = textBefore.match(/(^|[\s￼])#([a-zA-Z][\w/-]*)?$/);
  if (!match) return null;

  const query = match[2] ?? '';
  const blockStart = $position.start();
  // Position of the `#`. The boundary char (whitespace or atom) is at
  // index `match.index`; the `#` is one char after when boundary is a
  // real char, OR at index 0 when boundary is start-of-text (match[1]
  // is empty).
  const boundaryLen = match[1].length;
  const hashOffset = (match.index ?? 0) + boundaryLen;
  const triggerPos = blockStart + hashOffset;

  return {
    range: { from: triggerPos, to: $position.pos },
    query,
    text: `#${query}`,
  };
}

/**
 * Build the @tiptap/suggestion plugin. Sister to
 * `configureWikiLinkSuggestion` — same lifecycle, same
 * popup-positioning helper, same hidden-then-reveal pattern that
 * prevents the loading flash from measuring at the wrong position.
 */
export function configureTagSuggestion(editor: Editor) {
  let cachedTags: TagSummaryEntry[] = [];
  let tagsLoaded = false;
  let tagsPromise: Promise<TagSummaryEntry[]> | null = null;
  let fetchError: string | null = null;

  return Suggestion<TagSuggestionItem>({
    editor,
    pluginKey: tagSuggestionKey,
    char: '#',
    // null lets the custom matcher decide. The default `[' ']`
    // allowedPrefixes wouldn't trigger at start-of-paragraph; our
    // matcher handles that case explicitly.
    allowedPrefixes: null,
    findSuggestionMatch: tagMatcher,
    // Gate inside @tiptap/suggestion's apply() reducer keeps `state.active`
    // false in source mode — bridge-propagated `#` from CodeMirror cannot
    // mount the tag picker popup. Signal lives in `editor-mode-context.ts`.
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
        // Replace `#query` (the trigger range) with the `tag` atom.
        // Append a trailing space so the cursor moves cleanly past
        // the atom — mirrors slash-command insertion ergonomics.
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

      // Hover-driven highlight tracking: pointer movement over an
      // option updates `selectedIndex` so the visible highlight and
      // the Enter target stay unified. Without this, a user who
      // moved the pointer would see one row highlighted (last
      // arrow-key target) while Enter committed a different one
      // (whatever the keyboard had selected). The check vs. the
      // current value avoids redundant rerenders when `pointermove`
      // fires repeatedly on the same row.
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
          // Items have loaded — reveal the popup. reveal() triggers a
          // doPosition pass that measures the populated content (so
          // flip() correctly decides above/below), then unhides on
          // resolution. No separate doPosition call needed.
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
            // No item selected — fall back to inserting the typed
            // query as a new tag IF it parses. Otherwise let the
            // event propagate (e.g. Tab continues default behavior).
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
          // Positioning cleanup first (stop autoUpdate → remove popup
          // DOM); React cleanup last so if destroy() throws the DOM
          // is already clean.
          destroySuggestionPopup(posState);
          doPosition = null;
          reveal = null;
          renderer?.destroy();
          renderer = null;
          currentProps = null;
          selectedIndex = 0;
          // Reset cache — each `#` session re-fetches for freshness.
          // Tag list mutates often (every save can add new tags); a
          // stale cache would offer dead suggestions immediately
          // after deleting a tag elsewhere.
          cachedTags = [];
          fetchError = null;
          tagsLoaded = false;
          tagsPromise = null;
        },
      };
    },
  });
}
