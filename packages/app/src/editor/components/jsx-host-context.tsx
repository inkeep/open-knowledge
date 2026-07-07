/**
 * Host context exposed to descriptor components rendered inside
 * `JsxComponentView`. Lets a canonical (e.g. Embed) write back to its own
 * attrs without threading editor + pos through the renderProps spread —
 * keeping the descriptor's public prop surface (markdown attrs only) clean.
 *
 * Consumers: `useJsxComponentHost()` returns the active editor + pos.
 * `null` outside an active JsxComponentView render — components that need
 * host access should guard against it (e.g. server-side rendering, isolated
 * tests).
 */

import type { Editor } from '@tiptap/core';
import { createContext, type ReactNode, use } from 'react';

interface JsxComponentHost {
  editor: Editor;
  /**
   * Live document position of the wrapping jsxComponent node — must be
   * called at the moment the host write happens, NOT captured into a
   * snapshot variable. The render-time pos drifts whenever a concurrent
   * CRDT transaction inserts or removes content above this node, so a
   * stale snapshot used at pointerup time (seconds after render) could
   * target the wrong node. Returns `undefined` when the NodeView has
   * been unmounted (current doc no longer contains this position).
   */
  getPos: () => number | undefined;
  /**
   * Insert a child of the descriptor's `emptyChildName` at the end of
   * the container. `null` when the host descriptor isn't a compound
   * parent (no `emptyChildName`). Lets compound canonicals render their
   * own "add child" affordance inline (e.g. Tabs renders an "Add tab"
   * pill INSIDE its strip, next to the last tab pill — instead of the
   * default `.jsx-add-child-pill` overlay at the bottom of the wrapper)
   * without re-implementing the insert + selection + focus dance.
   */
  addChild: (() => void) | null;
}

const JsxComponentHostContext = createContext<JsxComponentHost | null>(null);

export function JsxComponentHostProvider({
  value,
  children,
}: {
  value: JsxComponentHost | null;
  children: ReactNode;
}) {
  return (
    <JsxComponentHostContext.Provider value={value}>{children}</JsxComponentHostContext.Provider>
  );
}

/** Hook — returns the active host (editor + pos) or null when called outside one. */
export function useJsxComponentHost(): JsxComponentHost | null {
  return use(JsxComponentHostContext);
}
