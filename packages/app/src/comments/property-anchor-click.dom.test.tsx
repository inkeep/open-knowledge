/**
 * The wiring around {@link threadAtValueOffset}: a real click on a real
 * `<textarea>` in a real property row.
 *
 * The matcher's own rules are pinned in `property-anchor-click.test.ts`. What
 * needs a DOM is everything the matcher cannot see — that the listener finds
 * the row, reads the caret the browser placed, and leaves the click otherwise
 * alone.
 */

import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Textarea } from '@/components/ui/textarea';
import type { CommentThread } from './types';

const opened: (string | null)[] = [];
let threads: CommentThread[] = [];

vi.doMock('./store', () => ({
  emitOpenThread: (id: string | null) => {
    opened.push(id);
  },
  // The double IS the store's state here: the listener reads it to decide
  // whether a click on an uncommented value has anything to stand down.
  getOpenThread: () => (opened.length === 0 ? null : opened[opened.length - 1]),
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

  test('a click into an uncommented value stands the open thread down', () => {
    // Same gesture the body reads as "I have moved on": with a comment open,
    // clicking text that carries none has to clear it, or the highlight stays
    // lit for a passage the reader has left. The two tests above pin the other
    // half — with nothing open, the same click says nothing at all.
    const { getByLabelText } = render(<Panel />);
    clickAt(getByLabelText('cuisine') as HTMLTextAreaElement, 8);
    clickAt(getByLabelText('protein') as HTMLTextAreaElement, 3);
    expect(opened).toEqual(['t1', null]);
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
});
