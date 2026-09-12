import { deriveIconColor, type MarkdownManager } from '@inkeep/open-knowledge-core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { liveProjection } from '../projection-binding';
import {
  createFullPrecisionResolver,
  liveCaretPmPosToSourceOffset,
  sourceOffsetToLiveCaretPos,
} from '../projection-coordinates';

const remoteCaretsKey = new PluginKey<DecorationSet>('okRemoteCarets');

export const REMOTE_CARET_CLASS = 'collaboration-cursor__caret';
export const REMOTE_CARET_LABEL_CLASS = 'collaboration-cursor__label';
export const REMOTE_CARET_HOST_CLASS = 'ok-remote-caret-host';

interface AwarenessCursor {
  anchor: unknown;
  head: unknown;
}

interface AwarenessUser {
  name?: string;
  color?: string;
  type?: string;
}

function renderCursor(user: Record<string, string>): HTMLElement {
  const cursor = document.createElement('span');
  cursor.classList.add(REMOTE_CARET_CLASS);
  cursor.style.borderColor = user.color;

  const label = document.createElement('div');
  label.classList.add(REMOTE_CARET_LABEL_CLASS);
  label.style.backgroundColor = user.color;
  label.style.color = deriveIconColor(user.color);
  label.textContent = user.name;
  cursor.append(label);

  return cursor;
}

/* STOP: y-codemirror.next's `cursor` field is the wire contract, not an internal detail. The
   awareness protocol JSON-encodes local state, so a peer reads `{type, tname, item, assoc}`
   rather than a RelativePosition instance -- createRelativePositionFromJSON is what turns it
   back into one. Publishing this exact shape is what makes a WYSIWYG caret render in a peer's
   source editor, and vice versa, with no second field and no translation layer. */
function toRelativePosition(value: unknown): Y.RelativePosition | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    return Y.createRelativePositionFromJSON(value as Record<string, unknown>);
  } catch {
    return null;
  }
}

function absoluteIndex(value: unknown, ytext: Y.Text): number | null {
  const relative = toRelativePosition(value);
  if (relative === null) return null;
  const doc = ytext.doc;
  if (doc === null) return null;
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
  if (absolute === null || absolute.type !== ytext) return null;
  return absolute.index;
}

export interface RemoteCaretsOptions {
  ytext: Y.Text;
  awareness: Awareness;
  md: MarkdownManager;
  isActive?: () => boolean;
}

export function createRemoteCaretsPlugin(options: RemoteCaretsOptions): Plugin<DecorationSet> {
  const { ytext, awareness, md } = options;
  const resolveFullPrecision = createFullPrecisionResolver(md);
  const isActive = options.isActive ?? ((): boolean => true);

  return new Plugin<DecorationSet>({
    key: remoteCaretsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decorations) {
        const refreshed = tr.getMeta(remoteCaretsKey) as DecorationSet | undefined;
        if (refreshed !== undefined) return refreshed;
        return decorations.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return remoteCaretsKey.getState(state);
      },
    },
    view(view) {
      let publishedAnchor: number | null = null;
      let publishedHead: number | null = null;
      let sourceChanged = true;

      /* STOP: read the projection through the plugin state and only from here -- never from
         inside another plugin's `apply`. Tiptap orders this plugin ahead of the binding, so the
         binding's state is absent mid-apply, and `adopt()` runs after the dispatch returns, so
         mid-apply the projection still describes the PREVIOUS document. Both make a rebuild
         there resolve the new document through the old map. */
      const build = (): DecorationSet => {
        const projection = liveProjection(view.state);
        if (projection === null) return DecorationSet.empty;

        const remote: Array<[number, Record<string, unknown>]> = [];
        for (const [clientId, raw] of awareness.getStates().entries()) {
          if (clientId === awareness.clientID) continue;
          const peer = raw as Record<string, unknown>;
          if (peer.cursor === undefined || peer.cursor === null) continue;
          remote.push([clientId, peer]);
        }
        if (remote.length === 0) return DecorationSet.empty;

        const full = resolveFullPrecision(projection);
        const size = view.state.doc.content.size;
        const decorations: Decoration[] = [];

        for (const [clientId, peer] of remote) {
          const cursor = peer.cursor as AwarenessCursor;
          const headIndex = absoluteIndex(cursor.head, ytext);
          if (headIndex === null) continue;
          const user = (peer.user ?? {}) as AwarenessUser;
          if (user.type === 'agent') continue;
          const raw = Math.max(
            0,
            Math.min(sourceOffsetToLiveCaretPos(full, view.state.doc, headIndex), size),
          );
          /* STOP: a widget decoration at a top-level block boundary is rendered as a direct
             child of .ProseMirror, between two paragraphs, where it reads as an empty paragraph
             that is not in the document -- visible in WYSIWYG, absent in markdown, and alarming.
             `near` is what keeps the position inside a textblock no matter what the map says. */
          const pos = TextSelection.near(view.state.doc.resolve(raw)).from;
          const attrs = { name: user.name ?? 'Anonymous', color: user.color ?? '#30bced' };
          decorations.push(
            Decoration.widget(pos, () => renderCursor(attrs), {
              key: `ok-remote-caret-${clientId}-${pos}`,
              side: 10,
              ignoreSelection: true,
            }),
          );
          /* STOP: the name label is positioned above its own line, which puts it outside the
             block's box, and `.ok-chunk-wrapper` carries `content-visibility: auto` -- whose
             paint containment clips it away entirely. The label has a full box and a background
             the whole time, so every measurement short of a screenshot says it is visible.
             `.node-codeBlock` opts out of the same containment for the same reason. */
          const $pos = view.state.doc.resolve(pos);
          if ($pos.depth >= 1) {
            decorations.push(
              Decoration.node($pos.before(1), $pos.after(1), { class: REMOTE_CARET_HOST_CLASS }),
            );
          }
        }

        return DecorationSet.create(view.state.doc, decorations);
      };

      /* STOP: this dispatches, so it must never be called from update() directly -- a dispatch
         re-enters update(). It is a microtask and not an animation frame on purpose: a remote
         change replaces the whole document, which drops every decoration mapped through it, and
         a frame of delay before rebuilding is a peer caret that blinks on every keystroke its
         owner makes. A microtask lands before paint, and after `adopt()` has run. */
      let refreshQueued = false;
      const refresh = (): void => {
        if (refreshQueued) return;
        refreshQueued = true;
        queueMicrotask(() => {
          refreshQueued = false;
          if (view.isDestroyed) return;
          view.dispatch(view.state.tr.setMeta(remoteCaretsKey, build()));
        });
      };

      /* STOP: `cursor` is a shared field -- yCollab owns it while the source editor is up. This
         editor stays mounted behind it, so clearing the field when this editor is not the active
         one deletes the source editor's caret out from under it. Not ours to clear: when
         inactive, publish nothing and leave the field alone. */
      const publish = (): void => {
        const local = awareness.getLocalState();
        if (local === null) return;
        if (!isActive() || !view.hasFocus()) return;
        const projection = liveProjection(view.state);
        if (projection === null) return;
        const full = resolveFullPrecision(projection);
        const { anchor, head } = view.state.selection;
        const anchorOffset = liveCaretPmPosToSourceOffset(full, view.state.doc, anchor);
        const headOffset = liveCaretPmPosToSourceOffset(full, view.state.doc, head);
        /* STOP: an unchanged offset is not an unchanged anchor. A write is one delete plus one
           insert, so the item a relative position is pinned to is destroyed by any edit that
           spans it, and a peer then resolves it to nothing and drops the caret. Re-pinning on
           every Y.Text change is what keeps the caret alive through the writer's own typing. */
        if (
          !sourceChanged &&
          local.cursor != null &&
          publishedAnchor === anchorOffset &&
          publishedHead === headOffset
        ) {
          return;
        }
        sourceChanged = false;
        publishedAnchor = anchorOffset;
        publishedHead = headOffset;
        awareness.setLocalStateField('cursor', {
          anchor: Y.createRelativePositionFromTypeIndex(ytext, anchorOffset),
          head: Y.createRelativePositionFromTypeIndex(ytext, headOffset),
        });
      };

      const onSourceChange = (): void => {
        sourceChanged = true;
        refresh();
      };
      ytext.observe(onSourceChange);

      const onAwarenessChange = (changes: {
        added: number[];
        updated: number[];
        removed: number[];
      }): void => {
        const touched = [...changes.added, ...changes.updated, ...changes.removed];
        if (touched.every((id) => id === awareness.clientID)) return;
        refresh();
      };
      awareness.on('change', onAwarenessChange);

      const onFocusChange = (): void => {
        publish();
      };
      view.dom.addEventListener('focus', onFocusChange);
      view.dom.addEventListener('blur', onFocusChange);

      publish();
      refresh();

      return {
        update(_updatedView, prevState) {
          publish();
          if (!prevState.doc.eq(view.state.doc)) refresh();
        },
        destroy() {
          ytext.unobserve(onSourceChange);
          awareness.off('change', onAwarenessChange);
          view.dom.removeEventListener('focus', onFocusChange);
          view.dom.removeEventListener('blur', onFocusChange);
          if (isActive() && awareness.getLocalState()?.cursor != null) {
            awareness.setLocalStateField('cursor', null);
          }
        },
      };
    },
  });
}
