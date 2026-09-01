import { type RefObject, useEffect } from 'react';
import { locateInValue } from './property-row-rect';
import { emitOpenThread, getOpenThread, getThreads } from './store';
import type { CommentThread } from './types';

const ROW_SELECTOR = '[data-testid="property-row"]';

function rowKeyOf(thread: CommentThread): string | null {
  if (thread.target.kind !== 'property') return null;
  const { key, path } = thread.target;
  return path.length === 0 ? key : String(path[path.length - 1]);
}

interface PlacedRange {
  threadId: string;
  start: number;
  end: number;
}

export function placeValueThreads(
  threads: readonly CommentThread[],
  rowKey: string,
  value: string,
): PlacedRange[] {
  const placed: PlacedRange[] = [];
  for (const thread of threads) {
    if (thread.status !== 'open') continue;
    if (rowKeyOf(thread) !== rowKey) continue;
    if (thread.anchor === null) {
      placed.push({ threadId: thread.id, start: 0, end: value.length });
      continue;
    }
    const range = locateInValue(value, thread.anchor.quote, thread.anchor.start, thread.anchor.end);
    if (range === null) continue;
    placed.push({ threadId: thread.id, start: range.start, end: range.end });
  }
  return placed;
}

export function threadAtValueOffset(
  threads: readonly CommentThread[],
  rowKey: string,
  value: string,
  offset: number,
): string | null {
  let hit: PlacedRange | null = null;
  for (const range of placeValueThreads(threads, rowKey, value)) {
    if (offset < range.start || offset > range.end) continue;
    if (hit === null || range.end - range.start < hit.end - hit.start) hit = range;
  }
  return hit?.threadId ?? null;
}

function valueControl(target: EventTarget | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement))
    return null;
  return target.closest(ROW_SELECTOR) === null ? null : target;
}

function rowKeyFor(control: HTMLElement): string | null {
  return control.closest(ROW_SELECTOR)?.getAttribute('data-key') ?? null;
}

function caretOffset(control: HTMLTextAreaElement | HTMLInputElement): number | null {
  try {
    return control.selectionStart;
  } catch {
    return null;
  }
}

export function usePropertyAnchorClick(
  containerRef: RefObject<HTMLElement | null>,
  docName: string,
): void {
  useEffect(() => {
    if (docName === '') return;
    const container = containerRef.current;
    if (container === null) return;

    const onClick = (event: MouseEvent) => {
      const control = valueControl(event.target);
      if (control === null) return;
      const rowKey = rowKeyFor(control);
      if (rowKey === null) return;
      const offset = caretOffset(control);
      if (offset === null) return;
      const threadId = threadAtValueOffset(getThreads(docName), rowKey, control.value, offset);
      if (threadId !== null) {
        emitOpenThread(threadId);
        return;
      }
      if (getOpenThread() !== null) emitOpenThread(null);
    };

    container.addEventListener('click', onClick);
    return () => {
      container.removeEventListener('click', onClick);
    };
  }, [containerRef, docName]);
}
