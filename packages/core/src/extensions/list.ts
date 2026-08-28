/**
 * Unified list + listItem TipTap extension.
 *
 * Single pair of node types matching mdast's nested `list` → `listItem+`
 * structure (replaces the BulletList/OrderedList/ListItem/TaskList/TaskItem
 * fragmentation).
 *
 * Schema names are mdast-canonical: `list` (not bulletList/orderedList)
 * and `listItem` (not taskItem). Bullet/ordered/task are distinguished
 * by attrs (`ordered`, `checked`).
 *
 * Commands are TipTap-idiomatic: toggleBulletList, toggleOrderedList,
 * toggleTaskList — matching existing UI callers in slash-command/items.ts
 * and bubble-menu/BlockTypeSelector.tsx.
 *
 * Keyboard shortcuts use prosemirror-schema-list utilities (wrapInList,
 * splitListItem, liftListItem, sinkListItem) which are designed for
 * nested list schemas.
 */

import { findParentNode, InputRule, mergeAttributes, Node, wrappingInputRule } from '@tiptap/core';
import type { NodeType, Node as PmNode } from '@tiptap/pm/model';
import { liftListItem as pmLiftListItem, wrapInList as pmWrapInList } from '@tiptap/pm/schema-list';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { findWrapping } from '@tiptap/pm/transform';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    list: {
      toggleBulletList: () => ReturnType;
      toggleOrderedList: () => ReturnType;
      toggleTaskList: () => ReturnType;
    };
  }
}

// ────────────────────────── Helpers ──────────────────────────

/** Check if a list node is a bullet list (not ordered, no checked items). */
function isBulletList(node: PmNode): boolean {
  return node.type.name === 'list' && !node.attrs.ordered;
}

/** Check if a list node is an ordered list. */
function isOrderedList(node: PmNode): boolean {
  return node.type.name === 'list' && !!node.attrs.ordered;
}

/** Check if a list has any task items (checked !== null). */
function hasTaskItems(node: PmNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.type.name === 'listItem' && child.attrs.checked !== null) {
      found = true;
    }
  });
  return found;
}

/**
 * Toggle between a specific list kind and no-list.
 *
 * If the selection is inside a list matching `predicate`, unwrap.
 * If inside a different list kind, swap the attrs/items.
 * If not in a list, wrap.
 */
function toggleListKind(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  listType: NodeType,
  itemType: NodeType,
  predicate: (node: PmNode) => boolean,
  listAttrs: Record<string, unknown>,
  itemAttrsOverride?: Record<string, unknown> | null,
): boolean {
  const parentList = findParentNode((node) => node.type.name === 'list')(state.selection);

  if (parentList && predicate(parentList.node)) {
    // Already in target kind → unwrap (lift)
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    return pmLiftListItem(itemType)(state, dispatch);
  }

  if (parentList) {
    // Inside a different list kind → swap attrs
    if (!dispatch) return true;
    const { tr } = state;
    // Update the list node's attrs
    tr.setNodeMarkup(parentList.pos, undefined, {
      ...parentList.node.attrs,
      ...listAttrs,
    });
    // If switching to/from task, update listItem checked attrs
    if (itemAttrsOverride !== undefined) {
      parentList.node.forEach((child, offset) => {
        if (child.type.name === 'listItem') {
          const itemPos = parentList.pos + 1 + offset;
          tr.setNodeMarkup(itemPos, undefined, {
            ...child.attrs,
            ...itemAttrsOverride,
          });
        }
      });
    }
    dispatch(tr);
    return true;
  }

  // Not in a list → wrap
  const canWrap = pmWrapInList(listType, listAttrs)(state, undefined);
  if (!canWrap) return false;
  if (!dispatch) return true;

  // Wrap and optionally set item attrs
  const result = pmWrapInList(listType, listAttrs)(state, (tr) => {
    if (itemAttrsOverride) {
      // After wrapping, walk up from the mapped position to find the new listItem
      const mappedPos = tr.mapping.map(state.selection.$from.pos);
      const $pos = tr.doc.resolve(mappedPos);
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type.name === 'listItem') {
          tr.setNodeMarkup($pos.before(d), undefined, {
            ...node.attrs,
            ...itemAttrsOverride,
          });
          break;
        }
      }
    }
    dispatch(tr);
  });
  return result;
}

/**
 * The checkbox marker a task-item rule captured: `' '` or `''` for unchecked,
 * `x`/`X` for checked. Empty is what the bare `[]` shorthand yields.
 */
function isCheckedMarker(marker: string | undefined): boolean {
  return marker === 'x' || marker === 'X';
}

/** `'X'` only for the non-canonical uppercase spelling, which round-trips. */
function uppercaseMarker(marker: string | undefined): 'X' | null {
  return marker === 'X' ? 'X' : null;
}

/**
 * Shared body of the task-item input rules: turn a just-typed checkbox marker
 * into a real checkbox on the item that owns the caret.
 *
 * Two contexts reach this, because the same keystrokes arrive in two shapes.
 * In a plain paragraph there is no item yet, so the block wraps into a fresh
 * `list`. Inside a `listItem` there already is one — the bullet rule fires on
 * `- ` long before the `[` is typed, so the marker rule's own prefix is gone by
 * then and every hyphenated spelling lands here instead. Wrapping in that
 * branch would nest a second list inside the item rather than tick it, so it
 * only retypes the item's attrs.
 *
 * Every gate runs before the first mutation, so a refusal cannot leave the
 * marker deleted with no checkbox to show for it. The wrapping branch wraps
 * BEFORE it deletes for that reason — deleting first would need a second
 * `blockRange` lookup, and its bail would sit after a mutation.
 *
 * Returns whether it applied, so the handlers can answer `null` when it did
 * not. That is the sibling convention (`math-input-rule.ts`,
 * `inline-link-input-rule.ts`) and a real backstop: the runner discards the
 * whole transaction on a `null` handler, steps included.
 */
function applyTaskItemRule(
  state: EditorState,
  range: { from: number; to: number },
  checked: boolean,
  checkboxChar: 'X' | null,
): boolean {
  const listType = state.schema.nodes.list;
  if (!listType) return false;

  const $from = state.doc.resolve(range.from);
  const itemDepth = $from.depth - 1;

  // Caret in the FIRST block of an existing item: tick that item in place.
  // Deeper or later blocks (a blockquote in the item, a continuation
  // paragraph) are not the item's marker position, so they fall through to
  // the wrapping branch and nest, which is what the markdown would say.
  if (
    itemDepth > 0 &&
    $from.node(itemDepth).type.name === 'listItem' &&
    $from.index(itemDepth) === 0
  ) {
    const item = $from.node(itemDepth);
    state.tr.delete(range.from, range.to).setNodeMarkup($from.before(itemDepth), undefined, {
      ...item.attrs,
      checked,
      sourceCheckboxChar: checkboxChar,
    });
    return true;
  }

  const blockRange = $from.blockRange();
  if (!blockRange) return false;
  // Gate on the pre-delete doc: `findWrapping` returns node-type descriptors
  // rather than positions, so the result stays valid across the deletion, and
  // deciding here is what keeps a refusal from leaving a bare deletion behind.
  const wrapping = findWrapping(blockRange, listType, { ordered: false });
  if (!wrapping) return false;

  // Past the last gate, so both steps land or neither does. Wrap first and
  // delete through the mapping: the wrap shifts every position after the
  // block's start, and asking the mapping is cheaper than re-deriving the
  // range and safer than assuming the delete left one behind.
  const tr = state.tr;
  tr.wrap(blockRange, wrapping);
  tr.delete(tr.mapping.map(range.from), tr.mapping.map(range.to));

  const $item = tr.doc.resolve(tr.mapping.map(range.from));
  for (let d = $item.depth; d > 0; d--) {
    const parentNode = $item.node(d);
    if (parentNode.type.name === 'listItem') {
      tr.setNodeMarkup($item.before(d), undefined, {
        ...parentNode.attrs,
        checked,
        sourceCheckboxChar: checkboxChar,
      });
      break;
    }
  }
  return true;
}

/**
 * The four input-rule patterns, named so the suite can assert against the
 * shipped values instead of a transcription. They were literals inside
 * `addInputRules` behind a keep-in-sync-manually comment, and drifted: the
 * mirrored bullet pattern kept a lookahead the real one no longer needed, so
 * the tests proving it excluded `- [ ] ` passed with it deleted.
 *
 * Each is anchored to the start of a textblock and ends at the caret; the
 * trailing `\s$` is load-bearing on all four, and on the bullet rule it is the
 * whole reason a checkbox spelling never reaches it.
 */
/** `- `, `* `, `+ ` — a plain bullet. */
export const BULLET_INPUT_RE = /^\s*([-+*])\s$/;
/** `1. `, `42) ` — an ordered marker, ordinal and delimiter captured. */
export const ORDERED_INPUT_RE = /^\s*(\d+)([.)])\s$/;
/** `- [ ] `, `* [x] ` — a checkbox WITH its list marker still attached. */
export const TASK_MARKER_INPUT_RE = /^\s*[-*+]\s\[([ xX]?)\]\s$/;
/** `[] `, `[ ] `, `[x] `, `[X] ` — a bare checkbox. */
export const TASK_BARE_INPUT_RE = /^\s*\[([ xX]?)\]\s$/;

// ────────────────────────── List Node ──────────────────────────

export const ListNode = Node.create({
  name: 'list',
  group: 'block list',
  content: 'listItem+',
  priority: 60,

  addAttributes() {
    return {
      ordered: { default: false },
      start: { default: 1 },
      spread: { default: false },
      bulletMarker: { default: null },
      listMarkerDelimiter: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'ul',
        getAttrs: () => ({ ordered: false }),
      },
      {
        tag: 'ol',
        getAttrs: (el) => ({
          ordered: true,
          start: (el as HTMLElement).getAttribute('start')
            ? Number((el as HTMLElement).getAttribute('start'))
            : 1,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const tag = node.attrs.ordered ? 'ol' : 'ul';
    const extraAttrs: Record<string, unknown> = {};
    if (node.attrs.ordered && node.attrs.start !== 1) {
      extraAttrs.start = node.attrs.start;
    }
    return [tag, mergeAttributes(HTMLAttributes, extraAttrs), 0];
  },

  addCommands() {
    return {
      toggleBulletList:
        () =>
        ({ state, dispatch }) => {
          const listType = state.schema.nodes.list;
          const itemType = state.schema.nodes.listItem;
          if (!listType || !itemType) return false;
          return toggleListKind(
            state,
            dispatch,
            listType,
            itemType,
            (n) => isBulletList(n) && !hasTaskItems(n),
            { ordered: false },
            { checked: null }, // clear task status when switching to bullet
          );
        },
      toggleOrderedList:
        () =>
        ({ state, dispatch }) => {
          const listType = state.schema.nodes.list;
          const itemType = state.schema.nodes.listItem;
          if (!listType || !itemType) return false;
          return toggleListKind(
            state,
            dispatch,
            listType,
            itemType,
            (n) => isOrderedList(n),
            { ordered: true },
            { checked: null }, // clear task status when switching to ordered
          );
        },
      toggleTaskList:
        () =>
        ({ state, dispatch }) => {
          const listType = state.schema.nodes.list;
          const itemType = state.schema.nodes.listItem;
          if (!listType || !itemType) return false;
          return toggleListKind(
            state,
            dispatch,
            listType,
            itemType,
            (n) => isBulletList(n) && hasTaskItems(n),
            { ordered: false },
            { checked: false }, // enable task mode
          );
        },
    };
  },

  addInputRules() {
    return [
      // Bullet list: - , * , + . The trailing `\s$` is what keeps the checkbox
      // spellings out, not a lookahead: the rule only matches while the marker
      // is followed by one space and nothing else, so `- [` has already stopped
      // matching before the bracket is closed. A `(?!\s*\[[ xX]?\])` guard
      // used to sit here claiming that job; it could never fire (the lookahead
      // body needs two characters and only the one space is ever left to read)
      // and every input agreed with it removed.
      //
      // joinPredicate: bullet and ordered lists share the single `list` node
      // type (distinguished by the `ordered` attr), so the default same-type
      // join would merge a freshly-typed list into ANY adjacent list. Only
      // join when the preceding list is the same kind — otherwise typing
      // `1. ` below a bullet list silently became an empty bullet item.
      wrappingInputRule({
        find: BULLET_INPUT_RE,
        type: this.type,
        getAttributes: (match) => ({
          ordered: false,
          bulletMarker: match[1],
        }),
        joinPredicate: (_match, node) => node.attrs.ordered === false,
      }),
      // Ordered list: 1. or 1)
      wrappingInputRule({
        find: ORDERED_INPUT_RE,
        type: this.type,
        getAttributes: (match) => ({
          ordered: true,
          start: Number(match[1]),
          listMarkerDelimiter: match[2],
        }),
        joinPredicate: (_match, node) => node.attrs.ordered === true,
      }),
      // Task list, hyphenated: `- [ ] `, `* [x] `, `+ [] `. Typing never reaches
      // this rule. The bullet rule above claims `- ` at the space, and the
      // runner matches against the CURRENT TEXTBLOCK's text, so by the time the
      // `[` is typed the marker is gone from the candidate string — the bare
      // rule below is what a keystroke sequence actually hits.
      //
      // Its one live route is a multi-character `handleTextInput` delivery: an
      // IME commit, dictation, autocorrect, or a text-expansion tool handing
      // over the finished marker in a single call, which still carries the
      // `- `. NOT paste — the input-rules plugin registers only
      // handleTextInput / handleKeyDown / compositionend, so pasted text never
      // reaches any input rule, and a pasted `- [ ] ` gets its checkbox from
      // `MarkdownManager.parse` on the clipboard path instead. Nor
      // `insertContent` / `setContent`, which dispatch transactions directly.
      new InputRule({
        find: TASK_MARKER_INPUT_RE,
        handler: ({ state, range, match }) =>
          applyTaskItemRule(state, range, isCheckedMarker(match[1]), uppercaseMarker(match[1]))
            ? undefined
            : null,
      }),
      // Task list, bare: `[] `, `[ ] `, `[x] `, `[X] `. This is TipTap's own
      // TaskItem rule (`inputRegex` in `@tiptap/extension-list`), which we
      // cannot use directly — it wraps into a `taskItem` node, and this schema
      // unified TaskList/TaskItem into `list`/`listItem` to stay
      // mdast-canonical. Two deliberate departures from its pattern:
      //
      //  - `[ xX]` where upstream has `[( |x]`. That class admits `(` and `|`
      //    literally, which reads as a slipped alternation `( |x)`; matching
      //    `[(] ` as a checkbox is not a behavior to copy.
      //  - `X` accepted, which upstream drops. `sourceCheckboxChar` exists so
      //    an authored `- [X] ` round-trips, so the rule has to be able to
      //    produce that state in the first place.
      //
      // Empty brackets are not GFM, but they are a trigger, not a
      // serialization: every spelling writes back as the canonical `- [ ] `.
      new InputRule({
        find: TASK_BARE_INPUT_RE,
        handler: ({ state, range, match }) =>
          applyTaskItemRule(state, range, isCheckedMarker(match[1]), uppercaseMarker(match[1]))
            ? undefined
            : null,
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-8': () => this.editor.commands.toggleBulletList(),
      'Mod-Shift-7': () => this.editor.commands.toggleOrderedList(),
      'Mod-Shift-9': () => this.editor.commands.toggleTaskList(),
    };
  },
});

// ────────────────────────── ListItem Node ──────────────────────────

// Do NOT lower this extension's priority below TipTap's built-in `Keymap`
// (default 100) — Keymap binds Enter → splitBlock, and at priority < 100 it
// wins the chain and splits the listItem's paragraph in place, producing a
// second `<p>` inside the same `<li>` instead of a new list item. The
// default priority (100) matches stock TipTap and lets our splitListItem
// run first; a previous `priority: 60` here regressed Enter on every list
// type.
export const ListItemNode = Node.create({
  name: 'listItem',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      checked: { default: null },
      spread: { default: false },
      // Source-form fidelity attrs captured at parse time; null = canonical form. sourceMarkerSpacing is the
      // space run between marker and content (`-  item` → 2);
      // sourceOrdinal the typed ordered ordinal (`1. a\n1. b` → both 1);
      // sourceCheckboxChar 'X' for the uppercase task checkbox;
      // sourceContinuationIndent the nested-list continuation indent
      // (`- a\n    - b` → 4).
      sourceMarkerSpacing: { default: null, rendered: false },
      sourceOrdinal: { default: null, rendered: false },
      sourceCheckboxChar: { default: null, rendered: false },
      sourceContinuationIndent: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'li',
        getAttrs: (el) => {
          const checkbox = (el as HTMLElement).querySelector('input[type="checkbox"]');
          return {
            checked: checkbox ? (checkbox as HTMLInputElement).checked : null,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    if (node.attrs.checked !== null) {
      return [
        'li',
        mergeAttributes(HTMLAttributes, {
          'data-type': 'taskItem',
          'data-checked': node.attrs.checked ? 'true' : 'false',
        }),
        [
          'label',
          { contenteditable: 'false' },
          [
            'input',
            {
              type: 'checkbox',
              ...(node.attrs.checked ? { checked: 'checked' } : {}),
            },
          ],
        ],
        ['div', 0],
      ];
    }
    return ['li', mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor, HTMLAttributes }) => {
      const li = document.createElement('li');
      Object.entries(
        mergeAttributes(
          HTMLAttributes,
          node.attrs.checked !== null
            ? { 'data-type': 'taskItem', 'data-checked': String(!!node.attrs.checked) }
            : {},
        ),
      ).forEach(([key, val]) => {
        if (val != null) li.setAttribute(key, String(val));
      });

      let checkboxLabel: HTMLLabelElement | null = null;
      let checkbox: HTMLInputElement | null = null;
      const contentDiv = document.createElement('div');

      // `disabled` must mirror editability, not snapshot it at creation. A pure
      // setEditable() flip updates view.editable without a doc change, so
      // ProseMirror never calls this NodeView's update() — a checkbox created
      // while read-only (e.g. content injected before the editor goes live)
      // would stay disabled forever. setEditable() emits 'update', so resync on
      // it (and in update() below for any silent editability change).
      const syncDisabled = () => {
        if (checkbox) checkbox.disabled = !editor.isEditable;
      };

      if (node.attrs.checked !== null) {
        checkboxLabel = document.createElement('label');
        checkboxLabel.contentEditable = 'false';

        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!node.attrs.checked;
        syncDisabled();
        editor.on('update', syncDisabled);

        checkbox.addEventListener('change', () => {
          const pos = getPos();
          if (pos === undefined || typeof pos !== 'number') return;
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              checked: checkbox?.checked ?? false,
            }),
          );
        });

        checkboxLabel.appendChild(checkbox);
        li.appendChild(checkboxLabel);
      }

      li.appendChild(contentDiv);

      return {
        dom: li,
        contentDOM: contentDiv,
        update(updatedNode: PmNode) {
          if (updatedNode.type !== node.type) return false;
          // Handle transition to/from task mode
          if ((updatedNode.attrs.checked !== null) !== (node.attrs.checked !== null)) {
            return false; // force re-create
          }
          if (checkbox && updatedNode.attrs.checked !== null) {
            checkbox.checked = !!updatedNode.attrs.checked;
            checkbox.disabled = !editor.isEditable;
            li.setAttribute('data-checked', String(!!updatedNode.attrs.checked));
          }
          node = updatedNode;
          return true;
        },
        destroy() {
          editor.off('update', syncDisabled);
        },
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => {
        // Only handle Tab when the cursor is inside a listItem — otherwise
        // pass through so other extensions (e.g., table) can handle it.
        const { $from } = this.editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'listItem') {
            return this.editor.commands.sinkListItem(this.name);
          }
        }
        return false;
      },
      'Shift-Tab': () => {
        const { $from } = this.editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'listItem') {
            return this.editor.commands.liftListItem(this.name);
          }
        }
        return false;
      },
    };
  },
});

/**
 * Combined export for registration in shared.ts.
 * Register both ListNode and ListItemNode to get the full list experience.
 */
export const List = ListNode;
export const ListItem = ListItemNode;
