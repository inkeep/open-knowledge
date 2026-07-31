/**
 * Landing flash — WYSIWYG (ProseMirror).
 *
 * The WYSIWYG twin of the source landing flash: a standalone inline decoration
 * over the range a mode-switch jump landed on, cleared after one shared flash
 * duration. Standalone (its own plugin key, its own lifetime) rather than an
 * extension of the agent-insert flash, which decorates agent-changed ranges on a
 * different, shorter clock.
 *
 * The removal timer lives on the view because there is only ever one landing
 * flash at a time. The caller starts the flash once the landed range is on
 * screen, so its expiry clock measures visible time, not dispatch latency.
 *
 * Decoration-only: it never moves the selection or focus.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { ResolveConfidence } from '../mode-switch-position-resolver';
import { FLASH_DURATION_MS } from './flash-shared';
import { clampFlashRange, OK_LANDING_FLASH_CLASS } from './landing-flash-shared';

export const landingFlashKey = new PluginKey<DecorationSet>('okLandingFlash');

interface LandingFlashMeta {
  /** Range (current-doc coordinates) to flash, replacing any prior flash. */
  add?: { from: number; to: number };
  /** Clear the flash. */
  clear?: boolean;
}

// Per-view removal timers. The plugin's view-destroy hook cancels the pending
// timer on teardown so it can never dispatch onto a destroyed view.
const removalTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

export function createLandingFlashPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: landingFlashKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decorations) {
        const meta = tr.getMeta(landingFlashKey) as LandingFlashMeta | undefined;
        let next = decorations.map(tr.mapping, tr.doc);
        if (meta?.clear) next = DecorationSet.empty;
        // A new landing replaces the prior flash rather than layering on it.
        if (meta?.add && meta.add.to > meta.add.from) {
          next = DecorationSet.create(tr.doc, [
            Decoration.inline(meta.add.from, meta.add.to, { class: OK_LANDING_FLASH_CLASS }),
          ]);
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return landingFlashKey.getState(state);
      },
    },
    view(editorView) {
      return {
        destroy() {
          const timer = removalTimers.get(editorView);
          if (timer !== undefined) {
            clearTimeout(timer);
            removalTimers.delete(editorView);
          }
        },
      };
    },
  });
}

/**
 * Flash the landed range and schedule its removal. A `clamped` or unverified
 * `ordinal` grade suppresses the flash (see `clampFlashRange`). Call this when
 * the range is on screen; the expiry timer starts here.
 */
export function flashWysiwygLanding(
  view: EditorView,
  from: number,
  to: number,
  grade: ResolveConfidence,
): void {
  const range = clampFlashRange(view.state.doc.content.size, from, to, grade);
  if (!range) return;
  view.dispatch(view.state.tr.setMeta(landingFlashKey, { add: range }));

  const prior = removalTimers.get(view);
  if (prior !== undefined) clearTimeout(prior);
  const timer = setTimeout(() => {
    removalTimers.delete(view);
    view.dispatch(view.state.tr.setMeta(landingFlashKey, { clear: true }));
  }, FLASH_DURATION_MS);
  removalTimers.set(view, timer);
}

/** TipTap wrapper that registers the plugin on the WYSIWYG editor. */
export const LandingFlash = Extension.create({
  name: 'okLandingFlash',
  addProseMirrorPlugins() {
    return [createLandingFlashPlugin()];
  },
});
