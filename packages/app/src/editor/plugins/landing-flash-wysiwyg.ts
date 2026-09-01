import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { ResolveConfidence } from '../mode-switch-position-resolver';
import { FLASH_DURATION_MS } from './flash-shared';
import { clampFlashRange, OK_LANDING_FLASH_CLASS } from './landing-flash-shared';

export const landingFlashKey = new PluginKey<DecorationSet>('okLandingFlash');

interface LandingFlashMeta {
  add?: { from: number; to: number };
  clear?: boolean;
}

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

export const LandingFlash = Extension.create({
  name: 'okLandingFlash',
  addProseMirrorPlugins() {
    return [createLandingFlashPlugin()];
  },
});
