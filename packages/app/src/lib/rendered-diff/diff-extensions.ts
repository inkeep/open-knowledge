/**
 * `diffExtensions` — the extension set for the read-only rendered-diff editor.
 *
 * Derived from the app's `sharedExtensions` so the diff renders with full
 * editor fidelity (same schema, same node views for lists/code/math/wiki-links
 * → correct ordered lists, tables, styling). Two adjustments:
 *
 *   1. Drop edit affordances (slash menu, drag handle, table controls, file
 *      handler, autolink/input rules, keyboard-nav, find/replace, selection +
 *      source-dirty observers). `editable:false` already makes most inert; the
 *      imperative DOM-mounters (drag handle, table controls) are dropped so
 *      their hover chrome never appears in a diff. An unmatched name simply
 *      stays (inert read-only) — safe.
 *   2. Swap the app `JsxComponent` (React NodeView → `componentMap` → `Mirror`,
 *      which opens a live `HocuspocusProvider` via `useMirrorSource`) for
 *      core's base `JsxComponent`, which renders statically via `toDOM`.
 *      `Mirror` is the only editor node view that opens a live provider on
 *      render, so this single swap keeps the read-only diff from spawning
 *      providers or network. Other embeds (Image/Video/Math/Callout/…) then
 *      render via static `toDOM` — a v1 simplification; rich per-embed
 *      rendering is future work.
 */
import { JsxComponent as CoreJsxComponent } from '@inkeep/open-knowledge-core';
import type { Extensions } from '@tiptap/core';
import { sharedExtensions } from '@/editor/extensions/shared';

const DROP_NAMES = new Set([
  'slashCommand',
  'blockDragHandle',
  'blockMover',
  'tableInsertControls',
  'fileHandler',
  'gfmAutolink',
  'inlineLinkInputRule',
  'keyboardNav',
  'tiptapFindReplace',
  'selectionState',
  'sourceDirtyObserver',
  'tabFocusTrap',
]);

export const diffExtensions: Extensions = sharedExtensions
  .filter((ext) => !DROP_NAMES.has(ext.name))
  .map((ext) => (ext.name === 'jsxComponent' ? CoreJsxComponent : ext));
