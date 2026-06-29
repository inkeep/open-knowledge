
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
      target.rect.left = 400;
    });
    expect(mutateRan).toBe(true);
    expect(target.animateCalls.length).toBe(0);
    flushRaf();
    expect(target.animateCalls.length).toBe(1);
    const [{ keyframes, options }] = target.animateCalls;
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
    expect(target.animateCalls.length).toBe(1);
  });

  test('reassigns the new animation id to ok-image-align-flip so subsequent cancels match', () => {
    installRafStub();
    installReducedMotionWindow(false);
    const target = makeStubTarget(100);
    const wrapper = makeStubWrapper(target);
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
