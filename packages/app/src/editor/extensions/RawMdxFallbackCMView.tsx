/**
 * RawMdxFallback NodeView with embedded CodeMirror 6.
 *
 * Implements the canonical ProseMirror + CodeMirror pattern
 * (prosemirror.net/examples/codemirror/) adapted for TipTap's React NodeView.
 *
 * Architecture (Precedent #28 — direct PM dispatch, NOT y-codemirror.next):
 *   CM keystroke → forwardUpdate → PM transaction → y-prosemirror → CRDT
 *   PM change → NodeView.update(node) → computeChange → CM transaction
 *   Single `updating` boolean prevents feedback loops.
 *
 * This NodeView embeds a CodeMirror EditorView inside a React component.
 * The CM instance is NOT mounted via React (would conflict with PM's DOM management).
 * Instead, CM is mounted imperatively into a ref'd container, and React
 * renders the chrome (badge, border) around it.
 */

import { Compartment } from '@codemirror/state';
import { EditorView as CMEditorView, keymap } from '@codemirror/view';
import { useLingui } from '@lingui/react/macro';
import type { NodeViewProps } from '@tiptap/core';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import type { Selection as PmSelection } from '@tiptap/pm/state';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import { NodeViewWrapper } from '@tiptap/react';
import { Trash2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { useConfigContext } from '@/lib/config-provider';
import { markUserTyping } from '../observers';
import { getEditorView } from '../utils/get-editor-view';
import { getYDoc } from '../utils/get-ydoc';
import { getSharedMarkdownManager } from '../utils/md-singleton';
import { classifySeverity, SEVERITY_STYLES } from '../utils/severity';
import { createNestedCMExtensions, darkTheme, lightTheme } from './nested-cm-extensions';

/**
 * Decide whether an arrow keystroke at the CM cursor should escape out of
 * the nested CM into the outer PM document. Returns the direction to escape
 * (`-1` = before the node, `+1` = after the node) or `null` if the key
 * should stay inside CM.
 *
 * Mirrors the canonical PM+CM example's `maybeEscape` per
 * <https://prosemirror.net/examples/codemirror/> adapted for CM 6's selection
 * API. Escapes only when the selection is a collapsed cursor at the document
 * boundary in the given direction — anything inside the doc keeps default
 * CM navigation.
 *
 * @param cmView CodeMirror view whose selection is being inspected
 * @param unit  `'line'` for Up/Down (check line boundary), `'char'` for
 *              Left/Right (check caret boundary)
 * @param dir   `-1` for Up/Left, `+1` for Down/Right
 */
export function shouldEscapeNestedCM(
  cmView: CMEditorView,
  unit: 'line' | 'char',
  dir: -1 | 1,
): boolean {
  const { state } = cmView;
  const main = state.selection.main;
  if (!main.empty) return false;
  if (unit === 'line') {
    const line = state.doc.lineAt(main.head);
    return dir < 0 ? line.from === 0 : line.to === state.doc.length;
  }
  return dir < 0 ? main.head === 0 : main.head === state.doc.length;
}

/**
 * Action a caller should apply to a CodeMirror view in response to a PM
 * selectionUpdate. Computed purely from state — the caller handles the
 * feedback-loop guard (`updatingRef`) and side effects (dispatch/focus).
 */
type CMForwardAction =
  | { kind: 'noop' }
  | { kind: 'focus' }
  | { kind: 'selection'; anchor: number; head: number };

/**
 * Given the outer PM selection and this NodeView's position, decide how to
 * mirror PM's selection into the nested CodeMirror editor:
 *
 *   - NodeSelection ON this exact node → take CM focus (cursor stays at
 *     CM's current position, matching canonical `selectNode` behavior).
 *   - TextSelection inside this node's content range → forward anchor +
 *     head with clamping, and take focus if not already.
 *   - Anything else → no-op.
 *
 * Offsets are clamped to `[0, cmDocLen]` because PM's content window
 * (`nodePos+1` ..= `nodePos+nodeSize-1`) can lag the CM doc during a
 * concurrent edit — out-of-range offsets would throw inside
 * `cmView.dispatch`. Clamping keeps the dispatch safe.
 *
 * Callers that find `{kind:'noop'}` must not dispatch — returning early on
 * noop is how we avoid PM→CM→PM cascades (together with `updatingRef`).
 */
export function computeCMSelectionForwarding(opts: {
  pmSel: PmSelection;
  nodePos: number;
  nodeSize: number;
  cmDocLen: number;
  cmSel: { anchor: number; head: number };
  cmHasFocus: boolean;
}): CMForwardAction {
  const { pmSel, nodePos, nodeSize, cmDocLen, cmSel, cmHasFocus } = opts;

  // NodeSelection ON this exact node — just take focus
  if (pmSel instanceof NodeSelection && pmSel.from === nodePos) {
    return cmHasFocus ? { kind: 'noop' } : { kind: 'focus' };
  }

  // TextSelection inside this node's content — forward anchor/head with clamping
  const nodeStart = nodePos + 1; // offset 0 of content
  const nodeEnd = nodePos + nodeSize - 1;
  if (pmSel.from >= nodeStart && pmSel.to <= nodeEnd) {
    const anchor = Math.max(0, Math.min(pmSel.anchor - nodeStart, cmDocLen));
    const head = Math.max(0, Math.min(pmSel.head - nodeStart, cmDocLen));
    if (cmSel.anchor === anchor && cmSel.head === head && cmHasFocus) {
      return { kind: 'noop' };
    }
    return { kind: 'selection', anchor, head };
  }

  return { kind: 'noop' };
}

/**
 * Attempt to upgrade a `rawMdxFallback`'s source back to its parsed form.
 * Given the current CM source and the PM schema, returns an array of PM
 * Nodes to replace the rawMdxFallback with, or `null` if the upgrade
 * shouldn't happen.
 *
 * Called on CM blur — matches Obsidian's live-preview cursor-exit
 * trigger, which for our nested-CM architecture collapses to browser
 * blur because nested CM focus IS the source reveal.
 *
 * **Multi-block upgrades are supported** — `parseWithFallback`'s
 * recovery often absorbs adjacent blocks into one fallback (a broken
 * MDX tag's scope isn't cleanly bounded, so the parser keeps
 * consuming until it finds a valid close or EOF, swallowing following
 * paragraphs). If the user fixes the broken tag, the source parses to
 * multiple VALID blocks. Returning all of them lets the caller splice
 * them all back in — matches the user's mental model ("I fixed the
 * broken thing; the whole fallback should go away").
 *
 * Returns `null` (= no-op, preserve the existing rawMdxFallback) when:
 *   - Parse produces zero blocks (empty source → let caller decide;
 *     `MarkdownManager.parse("")` actually short-circuits to one empty
 *     paragraph, so this branch is rarely hit in practice)
 *   - Parse result contains ANY `rawMdxFallback` child (source still
 *     invalid — the fallback recovery tried the fix and still failed
 *     on some part of the block; preserving the existing fallback
 *     beats churning Y.XmlElement identity for the same parse state
 *     per Precedent #10 on Item-preservation)
 *   - `parseWithFallback` is contractually never-throws, but
 *     `schema.nodeFromJSON` CAN throw on future schema-drift edges
 *     ("Invalid content for node ..."). Such throws are caught here
 *     and surface as a structured `raw-mdx-upgrade-failure` log event;
 *     the fallback stays in place so the user can keep editing.
 *     Silent throws would otherwise escape to CodeMirror's
 *     updateListener catch and leave the user with no signal.
 *
 * The caller must guard dispatch with `updatingRef` to prevent feedback
 * loops — this function is pure state inspection.
 */
export function tryParseUpgrade(source: string, schema: Schema): PmNode[] | null {
  const mgr = getSharedMarkdownManager();
  const json = mgr.parseWithFallback(source);
  let doc: PmNode;
  try {
    doc = schema.nodeFromJSON(json);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'raw-mdx-upgrade-failure',
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  if (doc.childCount === 0) return null;
  const blocks: PmNode[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    // Any remaining rawMdxFallback means the source is still invalid in
    // at least one sub-span — no upgrade, let the user keep editing.
    if (child.type.name === 'rawMdxFallback') return null;
    blocks.push(child);
  }
  return blocks;
}

/**
 * Compute the minimal change between two strings.
 * Returns null if they're identical.
 */
export function computeChange(
  oldVal: string,
  newVal: string,
): { from: number; to: number; text: string } | null {
  if (oldVal === newVal) return null;
  let start = 0;
  let oldEnd = oldVal.length;
  let newEnd = newVal.length;

  while (start < oldEnd && oldVal.charCodeAt(start) === newVal.charCodeAt(start)) {
    start++;
  }
  while (
    oldEnd > start &&
    newEnd > start &&
    oldVal.charCodeAt(oldEnd - 1) === newVal.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return { from: start, to: oldEnd, text: newVal.slice(start, newEnd) };
}

/**
 * Canonical prefix stamped on `reason` by `JsxComponentView.tsx` when the
 * source is an unregistered JSX component (descriptor name `*` / wildcard).
 * `classifySeverity` in `severity.ts` keys off the same prefix to map to
 * severity `'info'` — keep this in sync if either changes.
 */
const UNREGISTERED_REASON_PREFIX = 'Unregistered component:';

/**
 * Pull the unregistered component's name out of the `reason` attribute.
 * Returns `null` when the reason wasn't produced by the wildcard path —
 * the caller renders generic fallback chrome in that case.
 */
function extractUnregisteredComponentName(reason: string): string | null {
  if (!reason.startsWith(UNREGISTERED_REASON_PREFIX)) return null;
  const name = reason.slice(UNREGISTERED_REASON_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

export function RawMdxFallbackView({ node, editor, getPos }: NodeViewProps) {
  const { t } = useLingui();
  const cmContainerRef = useRef<HTMLDivElement>(null);
  const cmViewRef = useRef<CMEditorView | null>(null);
  const updatingRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const wordWrapCompartmentRef = useRef(new Compartment());
  const { resolvedTheme } = useTheme();
  const { merged } = useConfigContext();
  const wordWrap = merged?.editor?.wordWrap ?? true;
  const reason = (node.attrs.reason as string) || t`Parse failed`;
  const severity = classifySeverity(reason);
  const style = SEVERITY_STYLES[severity];
  // Wildcard chrome metadata. WCAG 4.1.2 (Name, role, value) requires the
  // unregistered-component fallback to expose an accessible name carrying
  // the component name; the accessibility E2E tests also assert the
  // `[data-jsx-component].jsx-component-wrapper--unregistered` selector
  // matches the wildcard wrapper. Both are satisfied for `info` severity
  // (the only producer of `Unregistered component:`-prefixed reasons is
  // `JsxComponentView`'s wildcard path). Other severities (`warn` /
  // `error`) carry generic parse / render error chrome — they're not
  // wildcards and don't take this metadata.
  const unregisteredComponentName =
    severity === 'info' ? extractUnregisteredComponentName(reason) : null;

  // CM→PM sync: forward CM changes as PM transactions.
  // Uses getPos() and getEditorView(editor) directly (both stable across renders)
  // instead of refs (React Compiler prohibits ref writes during render).
  // getEditorView avoids TipTap v3's throwing-proxy on `editor.view` during
  // recycle/remount races; returns undefined pre-mount so the existing
  // `if (!pmView) return` guards become live.
  const forwardUpdate = (newText: string) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined) return;

    const pmView = getEditorView(editor);
    if (!pmView) return;

    // Look up the current node at this position to get its size
    const currentNode = pmView.state.doc.nodeAt(pos);
    if (!currentNode) return;
    // Type gate — same defensive check the sibling on-blur upgrade handler
    // enforces. If a concurrent transaction (remote on-blur upgrade,
    // Observer B re-parse under the always-live parse path, agent write)
    // swapped the `rawMdxFallback` at this position for a `jsxComponent` or
    // anything else between CM's internal update and this callback firing,
    // writing CM's text into that node's content range would silently
    // corrupt its children. Bail on any type mismatch.
    if (currentNode.type.name !== 'rawMdxFallback') return;

    const start = pos + 1;
    const end = pos + currentNode.nodeSize - 1;

    // Always release the flag: if dispatch throws (e.g. position went stale
    // under a concurrent transaction), leaving the flag true would pin the
    // CM→PM bridge off for the rest of the NodeView's lifetime — the user
    // keeps typing but keystrokes never reach PM. React Compiler does not
    // support try/finally without a catch, so we catch/release/rethrow.
    updatingRef.current = true;
    try {
      const tr = pmView.state.tr;
      if (newText.length === 0) {
        tr.delete(start, end);
      } else {
        const textNode = pmView.state.schema.text(newText);
        tr.replaceWith(start, end, textNode);
      }
      pmView.dispatch(tr);
    } catch (err) {
      updatingRef.current = false;
      throw err;
    }
    updatingRef.current = false;
  };

  // Mount the CM instance imperatively (once).
  // biome-ignore lint/correctness/useExhaustiveDependencies: CM view mounts once imperatively; re-mount on deps change would destroy the editor state. Theme/word-wrap handled by separate compartment effects; content sync handled by PM→CM sync effect below.
  useEffect(() => {
    const container = cmContainerRef.current;
    if (!container) return;

    const themeCompartment = themeCompartmentRef.current;

    // Undo/Redo delegation to PM
    const undoRedoKeymap = keymap.of([
      {
        key: 'Mod-z',
        run: () => {
          editor.commands.undo();
          return true;
        },
      },
      {
        key: 'Mod-y',
        run: () => {
          editor.commands.redo();
          return true;
        },
      },
      {
        key: 'Mod-Shift-z',
        run: () => {
          editor.commands.redo();
          return true;
        },
      },
    ]);

    // Arrow-at-boundary escape to outer PM (canonical PM+CM pattern).
    // When the cursor reaches a CM doc boundary in a given direction, move
    // PM selection past the fallback node in that direction and hand focus
    // back. Canonical reference: https://prosemirror.net/examples/codemirror/
    // Without these, the cursor traps inside the nested CM — no keyboard
    // path exists to leave the block without clicking.
    const escapeToPM = (dir: -1 | 1): boolean => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof pos !== 'number') return false;
      const pmView = getEditorView(editor);
      if (!pmView) return false;
      const currentNode = pmView.state.doc.nodeAt(pos);
      if (!currentNode) return false;
      // Type gate — mirror the sibling on-blur upgrade handler. If the
      // rawMdxFallback has been swapped under us (concurrent upgrade,
      // Observer B re-parse), stepping past `pos + currentNode.nodeSize`
      // computed against a different node would misposition PM selection.
      if (currentNode.type.name !== 'rawMdxFallback') return false;
      const targetPos = dir < 0 ? pos : pos + currentNode.nodeSize;
      const selection = Selection.near(pmView.state.doc.resolve(targetPos), dir);
      pmView.dispatch(pmView.state.tr.setSelection(selection).scrollIntoView());
      pmView.focus();
      return true;
    };
    const escapeKeymap = keymap.of([
      {
        key: 'ArrowUp',
        run: (v) => (shouldEscapeNestedCM(v, 'line', -1) ? escapeToPM(-1) : false),
      },
      {
        key: 'ArrowLeft',
        run: (v) => (shouldEscapeNestedCM(v, 'char', -1) ? escapeToPM(-1) : false),
      },
      {
        key: 'ArrowDown',
        run: (v) => (shouldEscapeNestedCM(v, 'line', 1) ? escapeToPM(1) : false),
      },
      {
        key: 'ArrowRight',
        run: (v) => (shouldEscapeNestedCM(v, 'char', 1) ? escapeToPM(1) : false),
      },
    ]);

    const ydoc = getYDoc(editor);
    const extensions = createNestedCMExtensions({
      themeCompartment,
      resolvedTheme,
      ydoc: ydoc ?? undefined,
      wordWrapCompartment: wordWrapCompartmentRef.current,
      wordWrap,
      extraKeymaps: undoRedoKeymap,
    });
    extensions.push(escapeKeymap);

    // CM→PM sync via update listener. Two responsibilities:
    //   1. Doc changes → forward text into PM (existing behavior).
    //   2. Focus changes → set PM NodeSelection on this block when CM gains
    //      focus (e.g. user clicks inside CM). Without this, SelectionStatePlugin
    //      (Precedent #31) sees stale `state.selection` whenever CM has focus,
    //      so halo / aria-live report the wrong block. The guard in the
    //      canonical PM+CM example uses `updatingRef` to prevent PM→CM→PM
    //      loops; we reuse the same flag.
    extensions.push(
      CMEditorView.updateListener.of((update) => {
        if (update.docChanged && !updatingRef.current) {
          forwardUpdate(update.state.doc.toString());
        }
        if (update.focusChanged && update.view.hasFocus && !updatingRef.current) {
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos !== 'number') return;
          const pmView = getEditorView(editor);
          if (!pmView) return;
          const currentSel = pmView.state.selection;
          // Already a NodeSelection on this exact node → nothing to do
          if (currentSel instanceof NodeSelection && currentSel.from === pos) return;
          const currentNode = pmView.state.doc.nodeAt(pos);
          if (!currentNode) return;
          // Type gate — mirror the on-blur upgrade handler. If another
          // client / Observer B re-parse swapped the rawMdxFallback at
          // `pos` under us, creating a NodeSelection on that position
          // would land on an unrelated node.
          if (currentNode.type.name !== 'rawMdxFallback') return;
          updatingRef.current = true;
          try {
            pmView.dispatch(
              pmView.state.tr.setSelection(NodeSelection.create(pmView.state.doc, pos)),
            );
          } catch (err) {
            updatingRef.current = false;
            throw err;
          }
          updatingRef.current = false;
        }
        // On-blur upgrade: when the nested CM loses focus, re-parse the
        // current source. If it now parses to a single non-fallback block,
        // replace the rawMdxFallback in the outer PM doc with the parsed
        // node. See `tryParseUpgrade` header for the no-op cases — the
        // user keeps the fallback CM mid-edit when the source isn't yet
        // committable. Mirrors Obsidian Live Preview's cursor-exit commit
        // trigger (Obsidian uses cursor-range-overlap because its source
        // reveal is inline; our nested-CM source reveal collapses
        // cursor-exit to browser blur).
        if (update.focusChanged && !update.view.hasFocus && !updatingRef.current) {
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof pos !== 'number') return;
          const pmView = getEditorView(editor);
          if (!pmView) return;
          const currentNode = pmView.state.doc.nodeAt(pos);
          if (!currentNode || currentNode.type.name !== 'rawMdxFallback') return;

          const source = update.view.state.doc.toString();
          const replacement = tryParseUpgrade(source, pmView.state.schema);
          if (!replacement) return;

          updatingRef.current = true;
          try {
            pmView.dispatch(
              pmView.state.tr.replaceWith(pos, pos + currentNode.nodeSize, replacement),
            );
          } catch (err) {
            updatingRef.current = false;
            throw err;
          }
          updatingRef.current = false;
        }
      }),
    );

    const cmView = new CMEditorView({
      doc: node.textContent,
      extensions,
      parent: container,
    });

    cmViewRef.current = cmView;

    // Forward markUserTyping so SystemDocSubscriber's agent-focus typing
    // guard sees keystrokes originating inside the embedded CM editor
    // (global wall-clock timestamp; no per-doc state since precedent #14).
    const mark = () => markUserTyping();
    const dom = cmView.contentDOM;
    dom.addEventListener('keydown', mark);
    dom.addEventListener('paste', mark);
    dom.addEventListener('drop', mark);
    dom.addEventListener('cut', mark);
    const teardownTypingListeners = () => {
      dom.removeEventListener('keydown', mark);
      dom.removeEventListener('paste', mark);
      dom.removeEventListener('drop', mark);
      dom.removeEventListener('cut', mark);
    };

    return () => {
      teardownTypingListeners();
      cmView.destroy();
      cmViewRef.current = null;
    };
  }, []);

  // Theme hot-swap: each instance uses its own Compartment
  useEffect(() => {
    const cmView = cmViewRef.current;
    if (!cmView) return;
    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    cmView.dispatch({
      effects: themeCompartmentRef.current.reconfigure(theme),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const cmView = cmViewRef.current;
    if (!cmView) return;
    cmView.dispatch({
      effects: wordWrapCompartmentRef.current.reconfigure(
        wordWrap ? CMEditorView.lineWrapping : [],
      ),
    });
  }, [wordWrap]);

  // PM→CM selection sync (Precedent #31 + canonical PM+CM pattern): when
  // PM selection lands on or inside this node — via outer arrow navigation,
  // slash-insert-with-focus, programmatic commands — mirror it into CM so
  // the nested editor reflects the intended caret. Two cases:
  //   (a) NodeSelection on this node → CM just gets focus (cursor stays at
  //       its previous position, matching canonical `selectNode` behavior).
  //   (b) TextSelection inside the content range → forward the offsets into
  //       CM so the caret lands where PM meant it to.
  // Without this effect, the outer arrow handler (in raw-mdx-fallback.ts)
  // can move PM selection into the node but CM never reflects it, so the
  // visible caret is wherever CM happened to be.
  useEffect(() => {
    const handler = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof pos !== 'number') return;
      const cmView = cmViewRef.current;
      if (!cmView) return;
      if (updatingRef.current) return;
      const pmView = getEditorView(editor);
      if (!pmView) return;
      const currentNode = pmView.state.doc.nodeAt(pos);
      if (!currentNode) return;

      const action = computeCMSelectionForwarding({
        pmSel: pmView.state.selection,
        nodePos: pos,
        nodeSize: currentNode.nodeSize,
        cmDocLen: cmView.state.doc.length,
        cmSel: {
          anchor: cmView.state.selection.main.anchor,
          head: cmView.state.selection.main.head,
        },
        cmHasFocus: cmView.hasFocus,
      });

      if (action.kind === 'noop') return;

      // Symmetric feedback-loop guard release: both dispatch and focus can
      // throw (view destroyed mid-effect); release the flag in the catch
      // path so a later PM→CM sync can still run.
      updatingRef.current = true;
      try {
        if (action.kind === 'selection') {
          cmView.dispatch({ selection: { anchor: action.anchor, head: action.head } });
        }
        if (!cmView.hasFocus) cmView.focus();
      } catch (err) {
        updatingRef.current = false;
        throw err;
      }
      updatingRef.current = false;
    };
    editor.on('selectionUpdate', handler);
    return () => {
      editor.off('selectionUpdate', handler);
    };
  }, [editor, getPos]);

  // PM→CM sync: when the PM node's text content changes externally
  // (e.g., remote peer edit, agent write), update the CM view.
  const textContent = node.textContent;
  useEffect(() => {
    const cmView = cmViewRef.current;
    if (!cmView || updatingRef.current) return;

    const oldText = cmView.state.doc.toString();
    const change = computeChange(oldText, textContent);
    if (!change) return;

    // Symmetric release with forwardUpdate: a CM dispatch throw must not
    // strand the PM→CM bridge in the "skip" state forever. React Compiler
    // does not support try/finally without a catch, so we catch/release/rethrow.
    updatingRef.current = true;
    try {
      cmView.dispatch({
        changes: { from: change.from, to: change.to, insert: change.text },
      });
    } catch (err) {
      updatingRef.current = false;
      throw err;
    }
    updatingRef.current = false;
  }, [textContent]);

  const handleDelete = () => {
    const p = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof p !== 'number') return;
    editor.chain().focus().setNodeSelection(p).deleteSelection().run();
  };

  const wrapperClassName = unregisteredComponentName
    ? `raw-mdx-fallback-wrapper jsx-component-wrapper jsx-component-wrapper--unregistered relative my-2 py-2 rounded border border-dashed ${style.wrapperClass}`
    : `raw-mdx-fallback-wrapper relative my-2 py-2 rounded border border-dashed ${style.wrapperClass}`;
  // Wildcard wrappers participate in the `[data-jsx-component]` test-
  // selector contract (matches the same attribute registered components'
  // `JsxComponentView` emits at `data-jsx-component=""`) and announce
  // their identity to assistive tech via `role="group"` + `aria-label`.
  // Generic parse-error fallbacks omit these — they're not block
  // components and have no component name to surface.
  const wildcardChromeProps = unregisteredComponentName
    ? {
        'data-jsx-component': '',
        role: 'group' as const,
        'aria-label': t`Unknown component: ${unregisteredComponentName}`,
      }
    : {};

  return (
    <NodeViewWrapper
      className={wrapperClassName}
      contentEditable={false}
      data-drag-handle=""
      draggable="true"
      data-severity={severity}
      {...wildcardChromeProps}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required inside PM NodeView */}
      <div
        className="absolute top-1 right-1 z-10 flex items-center gap-1.5"
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${style.badgeClass}`}
          title={reason}
        >
          {style.label}
        </span>
        <button
          type="button"
          className="jsx-chrome-btn jsx-chrome-btn--delete"
          aria-label={t`Delete block`}
          onClick={handleDelete}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: <fieldset> is for form-control groupings with <legend>; this div hosts CodeMirror's contenteditable .cm-content (which carries its own role="textbox"), and the wrapper's purpose is to give SR users an accessible name for the embedded editing surface — role="group" is the WAI-ARIA-correct primitive (matches SlashCommandMenu and Field). */}
      <div
        ref={cmContainerRef}
        className="raw-mdx-fallback-cm"
        role="group"
        aria-label={t`Editing broken MDX source: ${reason}`}
      />
    </NodeViewWrapper>
  );
}
