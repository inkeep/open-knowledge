export interface ScrollReachTarget {
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
    };
  };
  options: { smoothScrollDuration?: number };
  scrollToBottom(): void;
  scrollToLine(line: number): void;
}

export function restoreScrollReach(term: ScrollReachTarget): void {
  const parked = term.buffer.active.viewportY;
  if (parked >= term.buffer.active.baseY) return;

  const smoothScrollDuration = term.options.smoothScrollDuration;
  term.options.smoothScrollDuration = 0;
  try {
    term.scrollToBottom();
    term.scrollToLine(parked);
  } finally {
    term.options.smoothScrollDuration = smoothScrollDuration;
  }
}
