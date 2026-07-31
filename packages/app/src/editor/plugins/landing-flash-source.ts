/**
 * Landing flash — Source (CodeMirror).
 *
 * A mark decoration over the range a mode-switch jump landed on, cleared after
 * one shared flash duration. Sibling to the agent-write flash, not an extension
 * of it: this fires on an explicit "view in source" landing, carries its own
 * lifetime, and reuses none of the agent-flash Y.Map observation.
 *
 * The removal timer lives on the view, not on a decoration timestamp, because
 * there is only ever one landing flash at a time (a new landing supersedes any
 * prior). The caller starts the flash once the landed range is on screen, so the
 * expiry clock measures visible time rather than dispatch-to-visible latency.
 *
 * Decoration-only: it never moves the selection or focus, so a plain toggle that
 * does not flash is unaffected and a jump's caret placement stays the caller's.
 */

import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import type { ResolveConfidence } from '../mode-switch-position-resolver';
import { FLASH_DURATION_MS } from './flash-shared';
import { clampFlashRange, OK_LANDING_FLASH_CLASS } from './landing-flash-shared';

const addLandingFlash = StateEffect.define<{ from: number; to: number }>();
const removeLandingFlash = StateEffect.define<null>();

const landingMark = Decoration.mark({ class: OK_LANDING_FLASH_CLASS });

/** Exposed so tests can read the live decoration set from a driven state. */
export const landingFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      // A new landing replaces the prior flash rather than layering on it.
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

// Per-view removal timers. The cleanup plugin below cancels the pending timer on
// view teardown so it can never dispatch onto a destroyed view (which throws).
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

/**
 * Flash the landed range and schedule its removal. A `clamped` or unverified
 * `ordinal` grade suppresses the flash (see `clampFlashRange`). Call this when
 * the range is on screen; the expiry timer starts here.
 */
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

/** The field plus its teardown-cleanup plugin, for a full-page source editor. */
export function landingFlashSource(): Extension {
  return [landingFlashField, landingFlashCleanup];
}
