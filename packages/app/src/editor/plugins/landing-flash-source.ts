import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import type { ResolveConfidence } from '../mode-switch-position-resolver';
import { FLASH_DURATION_MS } from './flash-shared';
import { clampFlashRange, OK_LANDING_FLASH_CLASS } from './landing-flash-shared';

const addLandingFlash = StateEffect.define<{ from: number; to: number }>();
const removeLandingFlash = StateEffect.define<null>();

const landingMark = Decoration.mark({ class: OK_LANDING_FLASH_CLASS });

export const landingFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addLandingFlash)) {
        next = Decoration.set([landingMark.range(effect.value.from, effect.value.to)]);
      } else if (effect.is(removeLandingFlash)) {
        next = Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const removalTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

const landingFlashCleanup = ViewPlugin.define((view) => ({
  destroy() {
    const timer = removalTimers.get(view);
    if (timer !== undefined) {
      clearTimeout(timer);
      removalTimers.delete(view);
    }
  },
}));

export function flashSourceLanding(
  view: EditorView,
  from: number,
  to: number,
  grade: ResolveConfidence,
): void {
  const range = clampFlashRange(view.state.doc.length, from, to, grade);
  if (!range) return;
  view.dispatch({ effects: addLandingFlash.of(range) });

  const prior = removalTimers.get(view);
  if (prior !== undefined) clearTimeout(prior);
  const timer = setTimeout(() => {
    removalTimers.delete(view);
    view.dispatch({ effects: removeLandingFlash.of(null) });
  }, FLASH_DURATION_MS);
  removalTimers.set(view, timer);
}

export function landingFlashSource(): Extension {
  return [landingFlashField, landingFlashCleanup];
}
