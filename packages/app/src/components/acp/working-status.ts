import { t } from '@lingui/core/macro';
import { useEffect, useState } from 'react';
import type { RenderedItem } from '@/lib/acp/thread-event-model';

export function activeToolKind(items: readonly RenderedItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== 'tool_call') continue;
    if (item.status === 'in_progress' || item.status === 'pending') return item.toolKind;
  }
  return null;
}

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

export const THINKING_HOLD_MS = { min: 3_500, max: 7_000 } as const;

export function nextThinkingIndex(current: number, count: number, random: number): number {
  if (count <= 1) return 0;
  return (current + 1 + Math.floor(random * (count - 1))) % count;
}

export function thinkingHoldMs(random: number): number {
  return THINKING_HOLD_MS.min + random * (THINKING_HOLD_MS.max - THINKING_HOLD_MS.min);
}

export function useThinkingLine(turnActive: boolean): number {
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * thinkingStatusLines().length),
  );
  useEffect(() => {
    if (!turnActive) return;
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
  return lines[((thinkingLine % lines.length) + lines.length) % lines.length];
}
