/**
 * The status line beside the working avatar.
 *
 * Two sources, and which one speaks is deliberate:
 *
 * - **A tool is in flight** → say what it is doing. The line then *changes* as
 *   the agent moves between reading, searching and editing, and that movement
 *   is itself the reassurance that the turn is alive.
 * - **Nothing in flight** (a long think, or a hang) → the line would otherwise
 *   sit frozen for minutes, which is exactly when a wait starts reading as
 *   stuck. So it drifts through a pool of phrases instead, in no fixed order
 *   and on a randomized beat, so the row keeps moving without ever implying
 *   progress it cannot see.
 *
 * Copy rules: present tense, no percentages, and never a time estimate — we
 * don't know one, and guessing is the fastest way to lose the reader's trust.
 */

import { t } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import type { RenderedItem } from '@/lib/acp/thread-event-model';

/**
 * The most recent tool call the agent has open, or null when it is between
 * calls. `pending` (accepted, not yet started) counts as in flight for the
 * same reason it draws a spinner — from the reader's side it is indistinguishable
 * from work already underway.
 */
export function activeToolKind(items: readonly RenderedItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== 'tool_call') continue;
    if (item.status === 'in_progress' || item.status === 'pending') return item.toolKind;
  }
  return null;
}

/**
 * The idle vocabulary, drawn from at random. Every line has to work at any
 * moment in a turn — a phrase that only makes sense late ("still going
 * strong") reads as nonsense four seconds in, now that order is not
 * guaranteed. Built inside a function so the macro resolves against the
 * active locale at call time rather than at module load.
 */
export function thinkingStatusLines(): string[] {
  return [
    t`Thinking…`,
    t`Mulling…`,
    t`Pondering…`,
    t`Percolating…`,
    t`Puzzling…`,
    t`Contemplating…`,
    t`Digging…`,
    t`Musing…`,
    t`Ruminating…`,
    t`Reflecting…`,
    t`Sifting…`,
    t`Sorting…`,
  ];
}

/** How long a line holds before the next one, in ms. Randomized within this
    range so the rotation never settles into an audible metronome. */
export const THINKING_HOLD_MS = { min: 3_500, max: 7_000 } as const;

/**
 * Pick an index other than `current`, uniformly over the remaining lines.
 * Offsetting by 1..count-1 rather than re-rolling guarantees the line actually
 * changes — a "rotation" that lands on the same phrase reads as a freeze.
 * `random` is a 0..1 sample, passed in so callers can make this deterministic.
 */
export function nextThinkingIndex(current: number, count: number, random: number): number {
  if (count <= 1) return 0;
  return (current + 1 + Math.floor(random * (count - 1))) % count;
}

export function thinkingHoldMs(random: number): number {
  return THINKING_HOLD_MS.min + random * (THINKING_HOLD_MS.max - THINKING_HOLD_MS.min);
}

/**
 * The index of the idle line currently showing.
 *
 * It moves on its own clock and nothing else: each turn opens on a freshly
 * drawn line, then a different one lands after every randomized hold. Streamed
 * output does NOT advance it — a line that changed on every chunk would flicker
 * too fast to read, and one that changed per message would make the phrasing
 * look like a report on the message rather than on the wait.
 *
 * Only runs while a turn is live — an idle thread schedules nothing.
 */
export function useThinkingLine(turnActive: boolean): number {
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * thinkingStatusLines().length),
  );
  useEffect(() => {
    if (!turnActive) return;
    // Redrawn per turn, not just per mount: without this a second turn resumes
    // wherever the last one stopped and opens on the word already on screen.
    setIndex(Math.floor(Math.random() * thinkingStatusLines().length));
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      timer = setTimeout(() => {
        setIndex((current) =>
          nextThinkingIndex(current, thinkingStatusLines().length, Math.random()),
        );
        schedule();
      }, thinkingHoldMs(Math.random()));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [turnActive]);
  return index;
}

/** Tool kinds come from the ACP adapter; anything unrecognized falls through
    to the idle vocabulary rather than inventing a description. */
function contextualStatus(toolKind: string | null): string | null {
  switch (toolKind) {
    case 'read':
      return t`Reading…`;
    case 'search':
      return t`Having a look around…`;
    case 'fetch':
      return t`Retrieving…`;
    case 'edit':
      return t`Drafting…`;
    case 'delete':
      return t`Tidying up…`;
    case 'execute':
      return t`Trying it out…`;
    case 'think':
      return t`Turning it over…`;
    default:
      return null;
  }
}

export function workingStatusText(toolKind: string | null, thinkingLine: number): string {
  const contextual = contextualStatus(toolKind);
  if (contextual !== null) return contextual;
  const lines = thinkingStatusLines();
  // Wrapped rather than bounds-checked so any index still yields a line — the
  // caller is a hook whose count could drift from this array's if one is cut.
  return lines[((thinkingLine % lines.length) + lines.length) % lines.length];
}
