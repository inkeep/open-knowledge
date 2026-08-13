/**
 * The wiring around {@link threadAtValueOffset}: a real click on a real
 * `<textarea>` in a real property row.
 *
 * The matcher's own rules are pinned in `property-anchor-click.test.ts`. What
 * needs a DOM is everything the matcher cannot see — that the listener finds the
 * row, reads the caret the browser placed, leaves the click otherwise alone, and
 * stamps the attribute the popover's dismisser looks for BEFORE that dismisser
 * runs.
 */

import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Textarea } from '@/components/ui/textarea';
import type { CommentThread } from './types';

const opened: (string | null)[] = [];
let threads: CommentThread[] = [];

vi.doMock('./store', () => ({
  emitOpenThreadPopover: (id: string | null) => {
    opened.push(id);
  },
  getThreads: () => threads,
}));

const { usePropertyAnchorClick } = await import('./property-anchor-click');

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    docName: 'recipes/chicken-alfredo-pasta',
    target: { kind: 'property', key: 'cuisine', path: [] },
    anchor: { quote: 'ian-American', prefix: '', suffix: '', start: 4, end: 16 },
    status: 'open',
    body: 'is this right?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: false,
    ...overrides,
  };
}

function Panel() {
  const ref = useRef<HTMLDivElement>(null);
  usePropertyAnchorClick(ref, 'recipes/chicken-alfredo-pasta');
  return (
    <div ref={ref}>
      {/* The real row markup this listener keys off — `FrontmatterRow`'s testid
          and key attribute, around the value widget it renders. */}
      <div data-testid="property-row" data-key="cuisine">
        <Textarea aria-label="cuisine" defaultValue="Italian-American" />
      </div>
      <div data-testid="property-row" data-key="protein">
        <Textarea aria-label="protein" defaultValue="chicken" />
      </div>
    </div>
  );
}

/** Click at a caret offset, the way a pointer would: mousedown, then click. */
function clickAt(field: HTMLTextAreaElement, offset: number) {
  field.setSelectionRange(offset, offset);
  field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  field.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  opened.length = 0;
  threads = [thread()];
});

afterEach(() => cleanup());

describe('clicking a commented property value', () => {
  test('a click on the passage opens its thread', () => {
    const { getByLabelText } = render(<Panel />);
    clickAt(getByLabelText('cuisine') as HTMLTextAreaElement, 8);
    expect(opened).toEqual(['t1']);
  });

  test('a click elsewhere in the same value opens nothing', () => {
    const { getByLabelText } = render(<Panel />);
    clickAt(getByLabelText('cuisine') as HTMLTextAreaElement, 1);
    expect(opened).toEqual([]);
  });

  test('a click in an uncommented row opens nothing', () => {
    const { getByLabelText } = render(<Panel />);
    clickAt(getByLabelText('protein') as HTMLTextAreaElement, 3);
    expect(opened).toEqual([]);
  });

  test('the click is not consumed — the caret the reader aimed at stands', () => {
    const { getByLabelText } = render(<Panel />);
    const field = getByLabelText('cuisine') as HTMLTextAreaElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    field.setSelectionRange(8, 8);
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(field.selectionStart).toBe(8);
  });

  test('mousedown stamps the attribute the popover dismisser exempts', () => {
    const { getByLabelText } = render(<Panel />);
    const field = getByLabelText('cuisine') as HTMLTextAreaElement;
    field.setSelectionRange(8, 8);
    // Read during the dismisser's own phase: it listens on `document` in the
    // bubble phase, which is strictly after this hook's capture listener.
    let seenDuringBubble: string | null = null;
    const spy = (event: Event) => {
      seenDuringBubble =
        (event.target as HTMLElement)
          .closest('[data-comment-thread]')
          ?.getAttribute('data-comment-thread') ?? null;
    };
    document.addEventListener('mousedown', spy);
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.removeEventListener('mousedown', spy);

    expect(seenDuringBubble).toBe('t1');
  });

  test('clicking the same passage twice keeps the thread open', () => {
    // The field report: the first click opened the thread and the second put it
    // back. Reproduced against a stand-in for the real dismisser, because the
    // second click is the FIRST one it is registered for — `CommentThreadPopover`
    // only binds `mousedown` while a thread is showing, so click one never meets
    // it and click two always does.
    const { getByLabelText } = render(<Panel />);
    const field = getByLabelText('cuisine') as HTMLTextAreaElement;
    clickAt(field, 8);

    const dismisser = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-comment-thread]')) return;
      opened.push(null);
    };
    document.addEventListener('mousedown', dismisser);
    clickAt(field, 8);
    document.removeEventListener('mousedown', dismisser);

    // No `null` in the middle: the dismisser has to see the attribute and stand
    // down, or the popover closes and reopens on one gesture.
    expect(opened).toEqual(['t1', 't1']);
  });

  test('an uncommented value carries no such attribute', () => {
    const { getByLabelText } = render(<Panel />);
    const field = getByLabelText('protein') as HTMLTextAreaElement;
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(field.hasAttribute('data-comment-thread')).toBe(false);
  });

  test('the attribute clears once the thread is gone', () => {
    const { getByLabelText } = render(<Panel />);
    const field = getByLabelText('cuisine') as HTMLTextAreaElement;
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(field.getAttribute('data-comment-thread')).toBe('t1');

    threads = [];
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(field.hasAttribute('data-comment-thread')).toBe(false);
  });
});
