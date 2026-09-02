export interface ScrollModelState {
  viewportY: number;
  scrollbarLine: number;
  pendingTarget: number | null;
}

export function createScrollModelState(
  viewportY: number,
  scrollbarLine = viewportY,
): ScrollModelState {
  return { viewportY, scrollbarLine, pendingTarget: null };
}

export function applyModelledScroll(
  state: ScrollModelState,
  target: number,
  smoothScrollDuration: number | undefined,
): void {
  if (target - state.viewportY === 0) return;
  if (smoothScrollDuration) {
    state.pendingTarget = target;
    return;
  }
  state.viewportY = target;
  state.scrollbarLine = target;
  state.pendingTarget = null;
}

export function settleModelledScroll(state: ScrollModelState): void {
  if (state.pendingTarget === null) return;
  state.viewportY = state.pendingTarget;
  state.scrollbarLine = state.pendingTarget;
  state.pendingTarget = null;
}

export function instrumentSmoothScrollOption(options: {
  smoothScrollDuration?: number;
}): () => number {
  let current = options.smoothScrollDuration;
  let writes = 0;
  Object.defineProperty(options, 'smoothScrollDuration', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (next: number | undefined) => {
      current = next;
      writes += 1;
    },
  });
  return () => writes;
}
