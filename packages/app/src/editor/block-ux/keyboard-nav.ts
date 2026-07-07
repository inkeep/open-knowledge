/**
 * Block UX — keyboard navigation L0-L4.
 *
 * L0: Bare arrow at textblock boundary → NodeSelect adjacent self-closing
 *     JSX wrapper (parity with click-to-NodeSelect for self-closing leaves;
 *     mirrors PM's native arrow-NodeSelect for `atom: true` leaves, extended
 *     to OK's container-style jsxComponent via the `childCount === 0` gate).
 * L1: Esc → selectParentNode (cursor in component → select the component;
 *     NodeSelection → TextSelection after the node on re-press)
 * L2: Arrow Up/Down in nav mode (NodeSelection → move between blocks)
 * L2c: Arrow Up at start of compound jsxComponent body → exit cleanly to
 *     TextSelection just above the wrapper. PM's default vertical-arrow
 *     handler (selectVertically + browser-native cursor motion) is
 *     unreliable across the contenteditable boundary nesting that the
 *     Callout NodeView creates (chrome contentEditable=false → body
 *     contentEditable=true). The deterministic exit is implemented here
 *     so the L0 forward gate stays consistent with the backward gate.
 * L2d: Bare arrow (Down/Right/Left/Up) at a textblock boundary adjacent to a
 *     compound jsxComponent → descend cleanly into the component body (first
 *     inner caret for forward Down/Right; last inner caret for backward
 *     Left/Up). The bare-arrow ENTRY mirror of L2c's EXIT: PM's native caret
 *     motion across the same isolating contentEditable boundary commits the PM
 *     selection only ASYNCHRONOUSLY (DOMObserver readback) and intermittently
 *     not at all under load, so the deterministic descent is dispatched here.
 * L3: Enter container exit (empty trailing paragraph → sibling after container)
 * L4: Escape priority chain (Suggestion > Radix popover > L1 > deselect > default)
 *
 * L0 and L2 share the ArrowUp/ArrowDown bindings — they are mutually
 * exclusive on selection type (L0 fires on TextSelection at the textblock
 * boundary; L2 fires on NodeSelection). Same for ArrowLeft/Right (L0 only).
 */

import { incrementJsxArrowNodeSelectFailed } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';

type ArrowDirection = 'up' | 'down' | 'left' | 'right';

/**
 * L0 helper: bare-arrow auto-NodeSelect for self-closing JSX wrappers.
 *
 * Fires when ALL of:
 *   - selection is empty (TextSelection at a caret position)
 *   - cursor is at the appropriate boundary of its textblock for `dir`
 *   - the adjacent block (next sibling for forward; prev sibling for
 *     backward) is a `jsxComponent` with `childCount === 0` — i.e. a
 *     self-closing leaf-equivalent like `<Callout type="note" title="X" />`
 *     or an empty `<Accordion title="X" />`
 *   - PM's `NodeSelection.isSelectable` agrees
 *
 * Compound JSX wrappers (Callout-with-body, populated Accordion) have
 * `childCount > 0` and fall through to PM default behavior (descend into
 * body content). Industry-universal — Notion, Anytype, Logseq, and
 * BlockSuite all descend into compound block content on bare arrow.
 *
 * Returns `true` (consume the event) on successful dispatch OR on caught
 * `RangeError` (concurrent CRDT edit shifted positions mid-dispatch; we
 * fall back silently rather than let the browser default fire after a
 * partial state mutation). Returns `false` (defer to PM/default) otherwise.
 */
function tryL0NodeSelect(editor: Editor, dir: ArrowDirection): boolean {
  const { state, view } = editor;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;

  const $head = state.selection.$head;
  const isForward = dir === 'down' || dir === 'right';

  let adj: ReturnType<typeof state.doc.nodeAt> | null = null;
  let adjPos = -1;
  if (isForward) {
    const afterPos = $head.after();
    if (afterPos >= state.doc.content.size) return false;
    adj = state.doc.nodeAt(afterPos);
    adjPos = afterPos;
  } else {
    const beforePos = $head.before();
    if (beforePos <= 0) return false;
    const $beforePos = state.doc.resolve(beforePos);
    adj = $beforePos.nodeBefore;
    if (!adj) return false;
    adjPos = beforePos - adj.nodeSize;
  }

  if (!adj) return false;
  if (adj.type.name !== 'jsxComponent') return false;
  if (adj.childCount !== 0) return false;
  if (!NodeSelection.isSelectable(adj)) return false;

  try {
    const sel = NodeSelection.create(state.doc, adjPos);
    editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed(dir);
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: dir,
        tier: 'L0',
        reason: err.message.slice(0, 500),
      }),
    );
    // Consume the event — either `NodeSelection.create` threw before any
    // mutation (the common case: stale position from a concurrent CRDT edit)
    // or `view.dispatch` partially applied the transaction. In both cases,
    // deferring to PM default after our telemetry emit would yield
    // inconsistent UX (sometimes caret motion, sometimes no-op) — the gate
    // already established this is a NodeSelect site.
    return true;
  }
}

/**
 * L2c helper: exit a compound jsxComponent at the up-direction boundary.
 *
 * Fires when ALL of:
 *   - selection is an empty TextSelection
 *   - cursor is at the start of its textblock (`view.endOfTextblock('up')`)
 *   - cursor's ancestor chain contains a `jsxComponent` (compound)
 *   - cursor is at the FIRST inline position of the FIRST descendant block
 *     of that jsxComponent (so exiting upward is the natural next step)
 *
 * The exit dispatches a `TextSelection.findFrom($exitPos, -1, textOnly)` —
 * the nearest TextSelection before the jsxComponent. If no valid
 * TextSelection exists (the jsxComponent is the first block in the doc),
 * the helper returns false and defers to PM default + browser native
 * cursor handling.
 *
 * Why this exists: PM's `selectVertically` + browser-native ArrowUp at the
 * top of a textblock inside an `isolating: true` jsxComponent is unreliable
 * in Chromium. The contenteditable nesting created by the React NodeView
 * (chrome=false → body=true) intermittently traps the cursor inside the
 * isolating boundary. The fix dispatches the exit transaction explicitly
 * so the boundary-cross is deterministic, not browser-dependent.
 *
 * Returns `true` (consume the event) on successful dispatch OR on caught
 * `RangeError`. Returns `false` (defer to PM/default) when the gates don't
 * match or no valid TextSelection found above.
 */
function tryExitCompoundJsxUp(editor: Editor): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock('up')) return false;

  const $head = state.selection.$head;

  // Find the immediate jsxComponent ancestor (closest enclosing).
  let jsxDepth = -1;
  for (let d = $head.depth - 1; d >= 1; d--) {
    if ($head.node(d).type.name === 'jsxComponent') {
      jsxDepth = d;
      break;
    }
  }
  if (jsxDepth < 0) return false;

  // Verify cursor is at the FIRST descendant block within the jsxComponent.
  // Walk from $head.depth down to jsxDepth+1, checking each ancestor is at
  // index 0 of its parent (i.e., first child at every level down to the
  // jsxComponent body).
  for (let d = $head.depth; d > jsxDepth; d--) {
    if ($head.index(d - 1) !== 0) return false;
  }

  // Position just before the jsxComponent (at the doc-level / parent-level).
  // `$head.before(jsxDepth)` always returns ≥ 0 for jsxDepth ≥ 1 (depth 1
  // siblings start at doc position 0); no runtime guard is needed.
  const exitPos = $head.before(jsxDepth);

  try {
    const $exitPos = state.doc.resolve(exitPos);
    // findFrom with textOnly=true returns null when no TextSelection exists
    // in the requested direction. We want a TextSelection (not a NodeSelection
    // on the previous block), so textOnly is load-bearing.
    const found = Selection.findFrom($exitPos, -1, true);
    if (!found || !(found instanceof TextSelection)) return false;
    editor.view.dispatch(state.tr.setSelection(found).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed('up');
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: 'up',
        tier: 'L2c',
        reason: err.message.slice(0, 500),
      }),
    );
    // Consume the event on RangeError — same rationale as L0's catch:
    // a concurrent CRDT edit shifted positions; falling back to PM default
    // after partial state mutation would yield inconsistent UX.
    return true;
  }
}

/**
 * L2d helper: descend INTO a compound jsxComponent at a textblock boundary.
 * The bare-arrow ENTRY mirror of `tryExitCompoundJsxUp` (which is the EXIT),
 * generalized over direction the way `tryL0NodeSelect` is.
 *
 * Fires when ALL of:
 *   - selection is an empty TextSelection
 *   - cursor is at the boundary of its textblock for `dir`
 *     (`view.endOfTextblock(dir)`)
 *   - the adjacent block (next sibling for forward down/right; prev sibling
 *     for backward left) is a `jsxComponent` with `childCount > 0` — a compound
 *     wrapper like `<Callout>body</Callout>` or a populated `<Accordion>`.
 *     Self-closing wrappers (`childCount === 0`) are L0's NodeSelect job and
 *     are excluded here.
 *
 * Dispatches a `TextSelection` at the body's FIRST inline position (forward)
 * or LAST inline position (backward) via `Selection.findFrom(..., textOnly)`,
 * instead of deferring to PM's `selectVertically`/`selectHorizontally` +
 * browser-native caret motion.
 *
 * Why this exists: identical to `tryExitCompoundJsxUp`'s rationale, for the
 * entry direction. The `isolating: true` jsxComponent NodeView nests a
 * `contentEditable=false` chrome region around a `contentEditable` body; PM's
 * native caret motion across that boundary is unreliable in Chromium — the
 * descent commits to `state.selection` only ASYNCHRONOUSLY via DOMObserver
 * readback (often never, under load), so the caret intermittently fails to
 * land in the body. ArrowUp got the deterministic L2c EXIT; the bare-arrow
 * compound ENTRY (descent) in every direction was still on the unreliable
 * native path — this is the mirror. The explicit dispatch makes the
 * boundary-cross synchronous and deterministic. Direction coverage matches
 * `tryL0NodeSelect` (all four arrows): a down-only descent would re-leave the
 * horizontal- and up-arrow descent on the same unreliable native path.
 *
 * Returns `true` (consume the event) on successful dispatch OR on caught
 * `RangeError`. Returns `false` (defer to PM/default) when the gates don't
 * match or no valid TextSelection exists inside the component.
 */
function tryEnterCompoundJsx(editor: Editor, dir: ArrowDirection): boolean {
  const { state, view } = editor;
  if (!(state.selection instanceof TextSelection)) return false;
  if (!state.selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;

  const $head = state.selection.$head;
  const isForward = dir === 'down' || dir === 'right';

  // Resolve the adjacent block + its start position (mirror of tryL0NodeSelect).
  let adj: ReturnType<typeof state.doc.nodeAt> | null = null;
  let adjPos = -1;
  if (isForward) {
    const afterPos = $head.after();
    if (afterPos >= state.doc.content.size) return false;
    adj = state.doc.nodeAt(afterPos);
    adjPos = afterPos;
  } else {
    const beforePos = $head.before();
    if (beforePos <= 0) return false;
    const $beforePos = state.doc.resolve(beforePos);
    adj = $beforePos.nodeBefore;
    if (!adj) return false;
    adjPos = beforePos - adj.nodeSize;
  }

  if (!adj) return false;
  if (adj.type.name !== 'jsxComponent') return false;
  // Self-closing wrappers are L0's job (NodeSelect); only compounds descend.
  if (adj.childCount === 0) return false;

  // The component spans [adjPos, adjPos + nodeSize). Forward descent targets
  // the FIRST inner text caret (search forward from just past the open token);
  // backward descent targets the LAST inner text caret (search backward from
  // just before the close token). textOnly is load-bearing: we want a
  // TextSelection inside the body, not a NodeSelection on a body block.
  const adjEnd = adjPos + adj.nodeSize;

  try {
    const fromPos = isForward ? adjPos + 1 : adjEnd - 1;
    const found = Selection.findFrom(state.doc.resolve(fromPos), isForward ? 1 : -1, true);
    if (!found || !(found instanceof TextSelection)) return false;
    // Guard: the landing must be strictly INSIDE this jsxComponent, not escaped
    // past either boundary (defends against a body whose only descendants hold
    // no text caret position).
    if (found.$head.pos <= adjPos || found.$head.pos >= adjEnd) return false;
    editor.view.dispatch(state.tr.setSelection(found).scrollIntoView());
    return true;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    incrementJsxArrowNodeSelectFailed(dir);
    console.warn(
      JSON.stringify({
        event: 'jsx-component-arrow-node-select-failed',
        direction: dir,
        tier: 'L2d',
        reason: err.message.slice(0, 500),
      }),
    );
    // Consume the event on RangeError — same rationale as L0/L2c: a concurrent
    // CRDT edit shifted positions; falling back to PM default after a partial
    // state mutation would yield inconsistent UX.
    return true;
  }
}

export const KeyboardNav = Extension.create({
  name: 'keyboardNav',
  priority: 50, // lower than Suggestion plugins so they intercept Escape first (L4)

  addKeyboardShortcuts() {
    return {
      // L1: Esc → selectParentNode (text → parent node) → deselect (node
      // → text after) → blur (top-level node → release editor focus).
      // The blur branch is the keyboard exit mechanism required by WCAG
      // 2.1.2 "No Keyboard Trap" (Level A): pair the `TabFocusTrap`
      // extension's universal `Tab` consume with a guaranteed keyboard
      // path out of the editor. Mirrors Notion's / Confluence's pattern
      // (Esc once selects the block, Esc again exits) and matches the
      // sibling CodeMirror SourceEditor's documented escape contract.
      Escape: ({ editor }) => {
        // L4 priority chain: Suggestion/Radix popover intercept first
        // (they're higher priority). We only fire if nothing else handled it.
        const { state } = editor;

        if (state.selection instanceof NodeSelection) {
          // Top-level NodeSelection has nowhere further to navigate inside
          // the document — the user has exhausted in-editor nav and wants
          // out. `$from.depth === 0` means the selected node's parent IS
          // the doc, so we're at the root. Blur releases focus to the
          // next tabbable element OUTSIDE the editor (chrome bar, sidebar).
          if (state.selection.$from.depth === 0) {
            editor.commands.blur();
            return true;
          }
          // Nested NodeSelection: deselect → TextSelection after the node
          const pos = state.selection.from + state.selection.node.nodeSize;
          const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
          const sel = TextSelection.near($pos);
          editor.view.dispatch(state.tr.setSelection(sel));
          return true;
        }

        // If TextSelection inside a component, select the component
        if (state.selection instanceof TextSelection) {
          return editor.commands.selectParentNode();
        }

        return false;
      },

      // L0 + L2c + L2d + L2: Arrow Up
      // L0 fires on TextSelection at the start-of-textblock boundary with an
      // adjacent self-closing JSX wrapper (NodeSelect it). L2c fires on
      // TextSelection at the start of a compound jsxComponent's first
      // descendant block, EXITING upward. L2d fires on TextSelection at the
      // start of a textblock whose previous sibling is a compound jsxComponent,
      // DESCENDING into that compound's last inner caret. L2 fires on
      // NodeSelection to step between block siblings. All are mutually exclusive
      // at their gates: L2c requires the cursor INSIDE a compound; L0/L2d act on
      // the adjacent previous sibling and split on its childCount (L0 self-
      // closing === 0, L2d compound > 0); L2 requires a NodeSelection.
      ArrowUp: ({ editor }) => {
        if (tryL0NodeSelect(editor, 'up')) return true;
        if (tryExitCompoundJsxUp(editor)) return true;
        if (tryEnterCompoundJsx(editor, 'up')) return true;

        const { state } = editor;
        if (!(state.selection instanceof NodeSelection)) return false;

        const pos = state.selection.from;
        const $pos = state.doc.resolve(pos);

        // Find the previous sibling block
        if ($pos.index($pos.depth) === 0) return false; // at first child
        const prevPos = $pos.before($pos.depth);
        if (prevPos <= 0) return false;

        // Resolve to the node before this one
        const $prevPos = state.doc.resolve(prevPos - 1);
        const prevNode = $prevPos.nodeBefore;
        if (!prevNode) return false;

        const prevNodePos = prevPos - 1 - prevNode.nodeSize + 1;
        if (prevNodePos < 0) return false;

        try {
          const sel = NodeSelection.create(state.doc, prevPos - prevNode.nodeSize);
          editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
          return true;
        } catch (err) {
          // Narrow to RangeError (stale position from concurrent CRDT edit);
          // re-throw other types so genuine bugs aren't silently swallowed.
          // Mirrors the L0 catch contract incl. counter + structured-warn
          // telemetry; the `tier: 'L2'` field on the event JSON disambiguates
          // L0 (auto-NodeSelect adj wrapper) from L2 (step to prev/next block)
          // for the same direction. Returns false (fall through to PM default)
          // because L2 didn't commit to a specific NodeSelect site the way L0
          // gates do — the next handler may still produce sensible motion.
          if (!(err instanceof RangeError)) throw err;
          incrementJsxArrowNodeSelectFailed('up');
          console.warn(
            JSON.stringify({
              event: 'jsx-component-arrow-node-select-failed',
              direction: 'up',
              tier: 'L2',
              reason: err.message.slice(0, 500),
            }),
          );
          return false;
        }
      },

      // L0 + L2d + L2: Arrow Down
      // L0 fires on TextSelection at the end-of-textblock boundary with an
      // adjacent self-closing JSX wrapper (NodeSelect it). L2d fires on
      // TextSelection at the end-of-textblock boundary with an adjacent
      // COMPOUND jsxComponent (descend into its body). L2 fires on
      // NodeSelection to step between block siblings. The three are mutually
      // exclusive at their gates (L0/L2d on TextSelection, L2 on NodeSelection;
      // L0 and L2d are exclusive via the adjacent wrapper's childCount —
      // L0 requires childCount===0, L2d requires childCount>0). Mirrors the
      // ArrowUp L0/L2c/L2 structure.
      ArrowDown: ({ editor }) => {
        if (tryL0NodeSelect(editor, 'down')) return true;
        if (tryEnterCompoundJsx(editor, 'down')) return true;

        const { state } = editor;
        if (!(state.selection instanceof NodeSelection)) return false;

        const pos = state.selection.from;
        const nodeSize = state.selection.node.nodeSize;
        const nextPos = pos + nodeSize;

        if (nextPos >= state.doc.content.size) return false;

        try {
          const nextNode = state.doc.nodeAt(nextPos);
          if (!nextNode) return false;
          const sel = NodeSelection.create(state.doc, nextPos);
          editor.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
          return true;
        } catch (err) {
          // Narrow to RangeError (stale position from concurrent CRDT edit);
          // re-throw other types so genuine bugs aren't silently swallowed.
          // Mirrors the L0 catch contract incl. counter + structured-warn
          // telemetry; the `tier: 'L2'` field on the event JSON disambiguates
          // L0 (auto-NodeSelect adj wrapper) from L2 (step to prev/next block)
          // for the same direction. Returns false (fall through to PM default)
          // because L2 didn't commit to a specific NodeSelect site the way L0
          // gates do — the next handler may still produce sensible motion.
          if (!(err instanceof RangeError)) throw err;
          incrementJsxArrowNodeSelectFailed('down');
          console.warn(
            JSON.stringify({
              event: 'jsx-component-arrow-node-select-failed',
              direction: 'down',
              tier: 'L2',
              reason: err.message.slice(0, 500),
            }),
          );
          return false;
        }
      },

      // L0 + L2d: Arrow Left — symmetric with ArrowUp at start-of-textblock.
      // L0 NodeSelects an adjacent self-closing wrapper; L2d descends into an
      // adjacent COMPOUND wrapper (to its last inner caret). No L2 analog (PM
      // doesn't move between block siblings on horizontal arrows when a
      // NodeSelection is active; vertical-only is the established convention
      // for block-step navigation).
      ArrowLeft: ({ editor }) =>
        tryL0NodeSelect(editor, 'left') || tryEnterCompoundJsx(editor, 'left'),

      // L0 + L2d: Arrow Right — symmetric with ArrowDown at end-of-textblock.
      // L0 NodeSelects an adjacent self-closing wrapper; L2d descends into an
      // adjacent COMPOUND wrapper (to its first inner caret).
      ArrowRight: ({ editor }) =>
        tryL0NodeSelect(editor, 'right') || tryEnterCompoundJsx(editor, 'right'),

      // L3: Enter container exit (from empty trailing paragraph of last child)
      Enter: ({ editor }) => {
        const { state } = editor;
        if (!(state.selection instanceof TextSelection)) return false;
        if (!state.selection.empty) return false;

        const $from = state.selection.$from;

        // Check: cursor is in a paragraph that's empty
        const parentNode = $from.parent;
        if (parentNode.type.name !== 'paragraph' || parentNode.textContent !== '') return false;

        // Check: the paragraph is inside a jsxComponent
        if ($from.depth < 2) return false;

        // Walk up to find the containing jsxComponent
        let componentDepth = -1;
        for (let d = $from.depth - 1; d >= 1; d--) {
          if ($from.node(d).type.name === 'jsxComponent') {
            componentDepth = d;
            break;
          }
        }
        if (componentDepth < 0) return false;

        // Check: this is the last paragraph in the last child
        const componentNode = $from.node(componentDepth);
        const paragraphIndex = $from.index(componentDepth);
        if (paragraphIndex !== componentNode.childCount - 1) return false;

        // Compute insertion position after the container
        const insertPos = $from.after(componentDepth);
        if (insertPos > state.doc.content.size) return false;

        // Delete the empty paragraph + insert new paragraph after the container
        const tr = state.tr;
        const emptyParaFrom = $from.before($from.depth);
        const emptyParaTo = $from.after($from.depth);
        tr.delete(emptyParaFrom, emptyParaTo);

        // After deletion, insertion position shifts
        const adjustedInsertPos = insertPos - (emptyParaTo - emptyParaFrom);
        const newPara = state.schema.nodes.paragraph.create();
        tr.insert(adjustedInsertPos, newPara);

        // Set cursor inside the new paragraph
        const cursorPos = adjustedInsertPos + 1;
        tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});
