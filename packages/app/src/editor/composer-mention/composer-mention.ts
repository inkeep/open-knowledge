/**
 * Self-contained TipTap pieces for the bottom "Ask AI" composer's rich input:
 * a minimal single-block schema, an atomic `@`-mention chip node, and the
 * `@`-typeahead that reuses the wiki-link search corpus + floating-ui popup
 * WITHOUT touching the wiki-link extension.
 *
 * The schema is deliberately tiny (doc → paragraph → text/hardBreak/mention) so
 * the composer is a lightweight freetext field, not a document editor — it must
 * never register in the active-editor registry (that stays owned by the real
 * document editors). `serializeComposerContent` turns the doc into the dispatch
 * payload: the instruction prose (chips inline as `@path`) plus the ordered,
 * de-duplicated `@path` list that rides the holistic assembler's `mentions`.
 */

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
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
} from '../extensions/suggestion-floating-ui';
import { fetchPages, filterPages, type PageItem } from '../extensions/wiki-link-suggestion';
import { lucideIconToSvgString } from '../registry/lucide-svg';
import { ComposerMentionMenu } from './ComposerMentionMenu';

/** A resolved mention suggestion: the doc identity, its display title, and the
 *  workspace-relative `@path` the chip serializes to. */
export interface MentionItem {
  /** Stable identity / list key — the page docName (extension-less) or asset path. */
  readonly docName: string;
  readonly title: string;
  /** Workspace-relative path the chip serializes to (e.g. `notes.md`). */
  readonly path: string;
}

/** Cap mirrors the wiki-link picker — 8 fits the popup and leaves ranking room. */
const MAX_MENTION_ITEMS = 8;

export const composerMentionSuggestionKey = new PluginKey('composerMentionSuggestion');

/** Map a page/asset/folder result to the chip's serialized path (pages gain
 *  `.md`; assets strip the leading slash; folders carry no `.md` suffix).
 *  Exported for unit coverage of the per-kind path mapping. */
export function pageItemToPath(item: PageItem): string {
  if (item.kind === 'asset') return item.docName.replace(/^\//, '');
  if (item.kind === 'folder') return item.docName;
  return docNameToRelativePath(item.docName);
}

// ---------------------------------------------------------------------------
// Minimal schema — a single paragraph of inline content. No headings, lists,
// marks, or block structure: this is a prompt field, not a document.
// ---------------------------------------------------------------------------

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
    // Shift+Enter inserts a soft line break; plain Enter is left for the host's
    // submit handler (editorProps.handleKeyDown in ComposerMentionInput).
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

/**
 * Atomic, inline `@`-mention chip. Renders `@label` (the doc title) to the
 * reader; serializes to `@path` for the agent (`renderText` + the walk in
 * `serializeComposerContent`). `atom: true` makes it a single, uneditable unit
 * the user deletes whole.
 *
 * The chip is its own context affordance: its LEADING `@`-icon doubles as the
 * remove control (Cursor pattern), so an inline `@`-mention reads as a removable
 * chip exactly like the host-level context chips (the top row is reserved for
 * NON-inline context — the auto-included current file — so an inline mention is
 * never duplicated up there). Styling mirrors `ComposerContextChips`'s chip:
 * leading icon-that-swaps-to-× + label, rounded muted pill, with NO trailing ×
 * and no reserved trailing slot, so the two read as one system.
 */
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

  // Node-view chip whose LEADING icon doubles as the remove control (Cursor
  // pattern): at rest the cell shows the same file-entry icon the `@`-picker,
  // top-row chip, command palette, and sidebar show for this path; on
  // hover/`:focus-within` it cross-fades to a × in the SAME fixed-size cell
  // (opacity only → the chip box never resizes, so the surrounding prompt text
  // never reflows). There is NO trailing × and no reserved trailing slot. Built
  // with plain DOM (the composer editor is ProseMirror-managed — shadcn-exempt).
  // Both glyphs are injected as inline-SVG strings (the node view is not React,
  // so it cannot render an `<Icon />`) and inherit `currentColor`. The button
  // stops mousedown from stealing the editor selection, then deletes the node by
  // its live position. Enter/Space activate it natively (it's a real `<button>`).
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const path = String(node.attrs.path ?? '');
      const fullLabel = String(node.attrs.label || node.attrs.path);

      const dom = document.createElement('span');
      dom.className = 'composer-mention-chip group/mention';
      dom.setAttribute('data-composer-mention', path);
      // The label ellipsizes; surface the full mention name/path on hover so it
      // stays legible (mirrors the top-row chip's `title`).
      dom.title = fullLabel;

      // Leading icon-button: two stacked glyphs (the file/type icon at rest, the
      // × on reveal) in one fixed cell, cross-faded via CSS `opacity`. This IS
      // the remove control.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'composer-mention-icon';
      // Imperative Lingui (the node view runs outside React, so `useLingui` is
      // unavailable). Reuse the host context-chip key so the two chip systems
      // share one translation (see ComposerContextChips).
      remove.setAttribute('aria-label', t`Remove ${fullLabel} from context`);

      const fileIcon = document.createElement('span');
      fileIcon.className = 'composer-mention-glyph composer-mention-glyph-icon';
      fileIcon.setAttribute('aria-hidden', 'true');
      // Same path → file-entry icon derivation the picker + top-row chip use.
      fileIcon.innerHTML = fileEntryPathIconToSvgString(path);
      remove.appendChild(fileIcon);

      const xIcon = document.createElement('span');
      xIcon.className = 'composer-mention-glyph composer-mention-glyph-x';
      xIcon.setAttribute('aria-hidden', 'true');
      xIcon.innerHTML = lucideIconToSvgString(X);
      remove.appendChild(xIcon);

      // mousedown would move the editor selection into/around the chip before
      // the click fires; prevent it so the delete lands cleanly.
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

      // atom node — no editable content hole; `dom` is the whole view.
      return { dom };
    };
  },

  addProseMirrorPlugins() {
    return [configureComposerMentionSuggestion(this.editor)];
  },
});

/** The full extension list for the composer's TipTap editor. An optional
 *  `placeholder` adds the TipTap Placeholder decoration shown while the field is
 *  empty — the bottom composer overlays its own rotating placeholder and passes
 *  none; the create composer passes a static string. */
export function composerMentionExtensions(options?: { placeholder?: string }) {
  return [
    ComposerDoc,
    ComposerParagraph,
    ComposerText,
    ComposerHardBreak,
    ComposerHistory,
    ComposerMention,
    ...(options?.placeholder ? [Placeholder.configure({ placeholder: options.placeholder })] : []),
  ];
}

/** A snapshot of the mention corpus's load state, read by the menu to choose
 *  between the loading spinner, the retry hint, and the results list. */
export interface MentionCorpusSnapshot {
  /** True until the first fetch settles (success OR failure). */
  readonly loaded: boolean;
  /** True when the most recent fetch attempt rejected. */
  readonly error: boolean;
}

/**
 * Owns the lazily-fetched mention corpus and its load state machine. Split out
 * of the suggestion config so the retry contract is unit-testable without
 * driving TipTap's full Suggestion lifecycle.
 *
 * Retry contract: the FIRST `@` fetches the corpus; on a rejected fetch the
 * state stays `loaded === false` (only `error` flips), so the NEXT `@` re-fetches
 * rather than locking the corpus empty for the whole session. `reset()` (called
 * on menu exit) clears everything so a freshly-created doc shows up next time.
 */
export function createMentionCorpus(fetch: () => Promise<PageItem[]> = fetchPages) {
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
          // Mark loaded ONLY on success — a failed first fetch must not lock the
          // corpus empty for the session; leaving `pagesLoaded` false (and
          // clearing the promise) lets the next `@` re-fetch.
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
        .map((page) => ({ docName: page.docName, title: page.title, path: pageItemToPath(page) }))
        .filter((item) => item.path !== '');
    },

    /** Drop the cache + load state so the next `@` re-fetches. */
    reset() {
      cachedPages = [];
      pagesLoaded = false;
      pagesPromise = null;
      fetchError = false;
    },
  };
}

/**
 * The `@`-typeahead plugin. Reuses `fetchPages` + `filterPages` (the same
 * `searchWorkspaceCorpus` ranking the wiki-link picker uses) and the shared
 * floating-ui popup. Page-only: selecting a result inserts an atomic chip.
 */
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
            { type: 'composerMention', attrs: { path: item.path, label: item.title } },
            { type: 'text', text: ' ' },
          ])
          .run();
      } catch (err) {
        // TipTap chains are atomic, so a partial insert cannot occur; surface
        // the failure for diagnostics and let the user retry with `@`.
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

      const onSelect = (item: MentionItem) => {
        currentProps?.command(item);
      };

      const computeMenuProps = (props: SuggestionProps<MentionItem>) => {
        const items = props.items ?? [];
        const { loaded, error } = corpus.snapshot();
        return {
          items,
          query: props.query ?? '',
          selectedIndex,
          onSelect,
          // Still loading until the first fetch settles; a rejected fetch ends the
          // loading state but surfaces `error` so the menu shows a retry hint.
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
          rerender();
          reveal?.();
        },

        onUpdate(props: SuggestionProps<MentionItem>) {
          currentProps = props;
          selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
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
          // Re-fetch on the next `@` so a freshly-created doc shows up.
          corpus.reset();
        },
      };
    },
  });
}

/**
 * Walk the composer doc into the dispatch payload. `instruction` is the typed
 * prose with each chip inline as `@path`; `mentions` is the ordered,
 * first-occurrence-de-duplicated `@path` list the assembler budgets and never
 * trims. Paragraphs join with newlines; hard breaks are newlines.
 */
export function serializeComposerContent(editor: Editor): {
  instruction: string;
  mentions: string[];
} {
  const mentions: string[] = [];
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
          }
        }
      } else if (inline.isText) {
        line += inline.text ?? '';
      } else if (inline.type.name === 'hardBreak') {
        line += '\n';
      }
    });
    lines.push(line);
  });

  return { instruction: lines.join('\n').trim(), mentions };
}

/** True when the composer holds no instruction text and no chips. */
export function isComposerEmpty(editor: Editor): boolean {
  const { instruction, mentions } = serializeComposerContent(editor);
  return instruction === '' && mentions.length === 0;
}
