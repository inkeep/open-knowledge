
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
  return typeof requestAnimationFrame === 'function';
}

function findAlignTarget(wrapper: HTMLElement | null | undefined): HTMLElement | null {
  if (!wrapper) return null;
  return wrapper.querySelector<HTMLElement>(ALIGN_TARGET_SELECTOR);
}

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
