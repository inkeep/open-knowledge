/**
 * FLIP-style animation for image / embed / video alignment changes. CSS
 * `text-align` is not animatable, so when the user clicks one of the
 * left / center / right alignment buttons the inline-block child of
 * `.jsx-component-wrapper` teleports to its new position. This helper
 * captures the child's pre-mutation bounding rect, runs the supplied
 * mutation (which dispatches `setNodeMarkup` → React re-render →
 * `data-align` attribute flips → CSS re-applies `text-align`), and on
 * the next animation frame plays a transform-based animation from the
 * old position to the new one via the Web Animations API.
 *
 * The wrapper itself stays at column width (see the alignment CSS in
 * `globals.css` — `text-align` on the wrapper, `display: inline-block`
 * on the child) so only the child needs to animate.
 *
 * Respects `prefers-reduced-motion: reduce` — the mutation still runs,
 * just without the animation. Falls back gracefully when the wrapper
 * is null, the child element isn't found, or the position shift is
 * below a sub-pixel threshold (e.g. clicking the already-active
 * button).
 */

const ALIGN_TARGET_SELECTOR = 'img, .ok-embed, .ok-video';

const FLIP_DURATION_MS = 220;

/** Matches `--ease-out-strong` in `globals.css`. Web Animations API
 * cannot read CSS custom properties, so this value is duplicated —
 * keep it in lockstep with the token consumed by every other
 * interactive transition in the editor. */
const FLIP_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';

const FLIP_ANIMATION_ID = 'ok-image-align-flip';

const PIXEL_SHIFT_THRESHOLD = 0.5;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function canScheduleAnimation(): boolean {
  // Guard against non-browser runtimes (Bun unit tests, SSR-ish paths).
  // `typeof` on an undeclared global is safe even when the binding
  // doesn't exist — direct identifier access would throw a
  // `ReferenceError`.
  return typeof requestAnimationFrame === 'function';
}

function findAlignTarget(wrapper: HTMLElement | null | undefined): HTMLElement | null {
  if (!wrapper) return null;
  return wrapper.querySelector<HTMLElement>(ALIGN_TARGET_SELECTOR);
}

/**
 * Run `mutate` and animate the inline-block child of `wrapper` from
 * its pre-mutation position to its post-mutation position. Safe to
 * call with `wrapper === null` — the mutation still runs, the
 * animation is skipped.
 *
 * Rapid clicks (left → right → left) cancel any in-flight FLIP
 * animation on the same child so the next animation starts from the
 * current visual position rather than fighting an existing one.
 */
export function runWithAlignAnimation(wrapper: HTMLElement | null, mutate: () => void): void {
  if (prefersReducedMotion() || !canScheduleAnimation()) {
    mutate();
    return;
  }

  const before = findAlignTarget(wrapper);
  if (!before) {
    mutate();
    return;
  }

  const beforeLeft = before.getBoundingClientRect().left;

  mutate();

  requestAnimationFrame(() => {
    const after = findAlignTarget(wrapper);
    if (!after) return;

    // Cancel any in-flight FLIP on this element BEFORE measuring
    // `afterLeft`. `getBoundingClientRect()` includes the active
    // animation's `translateX`, so reading the rect with the old
    // animation still composited produces an `afterLeft` that's offset
    // by the in-flight transform magnitude. The new animation would
    // then overshoot its start position by exactly that magnitude —
    // exactly the rapid-click visual jump this helper exists to
    // prevent. Cancelling first snaps the element to its true CSS
    // position; the subsequent measurement, dx computation, and new
    // `animate()` call run inside the same rAF callback so no
    // intermediate frame is painted between the snap and the new
    // animation's first keyframe.
    for (const animation of after.getAnimations()) {
      if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
    }

    const afterLeft = after.getBoundingClientRect().left;
    const dx = beforeLeft - afterLeft;
    if (Math.abs(dx) < PIXEL_SHIFT_THRESHOLD) return;

    const flip = after.animate(
      [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
      { duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: 'none' },
    );
    flip.id = FLIP_ANIMATION_ID;
  });
}
