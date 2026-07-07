/**
 * runWithAlignAnimation — unit tests for the FLIP helper used by the
 * image alignment buttons (bubble menu + chrome bar). The helper's
 * core contract: `mutate()` ALWAYS runs, and the animation is best-
 * effort layered on top when the environment supports it. The
 * fallbacks (no DOM, no rAF, no animatable target, sub-pixel shift,
 * `prefers-reduced-motion: reduce`) are the load-bearing surface — a
 * broken FLIP must not block the alignment change itself.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { runWithAlignAnimation } from './animate-align-change';

interface StubAnimation {
  id: string;
  cancel: () => void;
}

interface StubTarget {
  rect: { left: number };
  getBoundingClientRect(): { left: number };
  getAnimations(): StubAnimation[];
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): StubAnimation;
  animateCalls: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }>;
}

function makeStubTarget(initialLeft: number): StubTarget {
  const animations: StubAnimation[] = [];
  const animateCalls: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  const target: StubTarget = {
    rect: { left: initialLeft },
    getBoundingClientRect() {
      return { left: this.rect.left };
    },
    getAnimations() {
      return [...animations];
    },
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      animateCalls.push({ keyframes, options });
      const animation: StubAnimation = { id: '', cancel: () => {} };
      animations.push(animation);
      return animation;
    },
    animateCalls,
  };
  return target;
}

function makeStubWrapper(target: StubTarget | null): HTMLElement {
  return {
    querySelector(selector: string) {
      // Match the production selector to keep the test honest — a regression
      // that renames `.ok-embed` / `.ok-video` or stops scanning for `img`
      // would silently skip the animation in production but pass a test that
      // lets any selector through.
      if (selector === 'img, .ok-embed, .ok-video') return target;
      return null;
    },
  } as unknown as HTMLElement;
}

const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;
const originalWindow = (globalThis as { window?: unknown }).window;

let rafQueue: FrameRequestCallback[] = [];

function installRafStub() {
  rafQueue = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
}

function flushRaf() {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) cb(performance.now());
}

function installReducedMotionWindow(matches: boolean) {
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches }),
  };
}

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  rafQueue = [];
});

describe('runWithAlignAnimation', () => {
  test('runs mutate when wrapper is null (no DOM ref available)', () => {
    const mutate = mock(() => {});
    runWithAlignAnimation(null, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test('runs mutate when requestAnimationFrame is unavailable', () => {
    // No rAF stub installed — Bun's plain runtime path. The helper must
    // fall back gracefully rather than throwing a ReferenceError that
    // would swallow the alignment change.
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    const mutate = mock(() => {});
    runWithAlignAnimation(wrapper, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(target.animateCalls.length).toBe(0);
  });

  test('runs mutate without animating when prefers-reduced-motion is reduce', () => {
    installRafStub();
    installReducedMotionWindow(true);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    const mutate = mock(() => {});
    runWithAlignAnimation(wrapper, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    flushRaf();
    expect(target.animateCalls.length).toBe(0);
  });

  test('runs mutate when no align target is found in the wrapper', () => {
    installRafStub();
    installReducedMotionWindow(false);
    const wrapper = makeStubWrapper(null);
    const mutate = mock(() => {});
    runWithAlignAnimation(wrapper, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    flushRaf();
  });

  test('schedules a FLIP animation when the child shifts horizontally', () => {
    installRafStub();
    installReducedMotionWindow(false);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    let mutateRan = false;
    runWithAlignAnimation(wrapper, () => {
      mutateRan = true;
      // Production: setNodeMarkup → React commits → CSS text-align
      // re-applies → inline-block child sits at a new position by the
      // next paint. Simulate by shifting the stub's left.
      target.rect.left = 400;
    });
    expect(mutateRan).toBe(true);
    expect(target.animateCalls.length).toBe(0);
    flushRaf();
    expect(target.animateCalls.length).toBe(1);
    const [{ keyframes, options }] = target.animateCalls;
    // dx = beforeLeft - afterLeft = 100 - 400 = -300; the FLIP starts
    // the child at its old visual position (-300px relative to its new
    // location) and tweens to 0.
    expect(keyframes).toEqual([
      { transform: 'translateX(-300px)' },
      { transform: 'translateX(0)' },
    ]);
    expect(options.duration).toBe(220);
  });

  test('skips animation when the position shift is below the sub-pixel threshold', () => {
    installRafStub();
    installReducedMotionWindow(false);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    // Position barely shifts — e.g. user re-clicks the already-active
    // alignment button. The threshold guards against firing an empty
    // animation every time the bubble menu blurs+refocuses.
    runWithAlignAnimation(wrapper, () => {
      target.rect.left = 100.3;
    });
    flushRaf();
    expect(target.animateCalls.length).toBe(0);
  });

  test('cancels any in-flight FLIP animation before starting a new one', () => {
    installRafStub();
    installReducedMotionWindow(false);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    const inFlight: StubAnimation = { id: 'ok-image-align-flip', cancel: mock(() => {}) };
    const unrelated: StubAnimation = { id: 'some-other-anim', cancel: mock(() => {}) };
    // Patch getAnimations to return our seeded animations once, then
    // whatever the production code appends after that.
    let firstCall = true;
    target.getAnimations = () => {
      if (firstCall) {
        firstCall = false;
        return [inFlight, unrelated];
      }
      return [];
    };
    runWithAlignAnimation(wrapper, () => {
      target.rect.left = 400;
    });
    flushRaf();
    expect(inFlight.cancel).toHaveBeenCalledTimes(1);
    expect(unrelated.cancel).toHaveBeenCalledTimes(0);
    // Also pins that the cancel does NOT short-circuit the new
    // animation — a regression that returned early after cancelling
    // would leave the user staring at the snapped-back element with
    // no slide. The new animate() call must still fire.
    expect(target.animateCalls.length).toBe(1);
  });

  test('reassigns the new animation id to ok-image-align-flip so subsequent cancels match', () => {
    // Pins the contract: production reassigns `flip.id` after
    // `element.animate(...)` so the next invocation's `getAnimations()`
    // loop can identify and cancel it by id. If the reassignment is
    // ever removed, rapid-click cancellation silently breaks (loop
    // filter never matches the empty default id) and FLIPs would
    // compound visually — without this assertion, no other test
    // catches it.
    installRafStub();
    installReducedMotionWindow(false);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
    // Capture the Animation returned from `animate()` so we can
    // inspect its id AFTER the helper has reassigned it. The base
    // stub's `animate()` returns an animation with `id: ''`; the
    // helper's `flip.id = FLIP_ANIMATION_ID` line is what makes the
    // assertion pass.
    let returnedAnimation: StubAnimation | undefined;
    const baseAnimate = target.animate.bind(target);
    target.animate = (keyframes, options) => {
      returnedAnimation = baseAnimate(keyframes, options);
      return returnedAnimation;
    };
    runWithAlignAnimation(wrapper, () => {
      target.rect.left = 400;
    });
    flushRaf();
    expect(returnedAnimation).toBeDefined();
    expect(returnedAnimation?.id).toBe('ok-image-align-flip');
  });
});
