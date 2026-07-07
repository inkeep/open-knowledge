/**
 * DOM tests for `usePublishFrontmatterSelection` — the hook that wires
 * the property panel's plain-React widgets into the selection-context store so a
 * highlight inside a property value feeds the composer exactly like a body-text
 * selection (keyed `(docName, 'frontmatter')`). Two highlight sources are
 * covered: a form field (textarea — the highlight is its own
 * `selectionStart..selectionEnd`, NOT part of `window.getSelection()`) and a
 * DOM Range over a static value display.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { getSelectionContext, publishSelectionContext } from '@/editor/selection-context';
import { usePublishFrontmatterSelection } from './use-selection-context';

function Harness({ docName }: { docName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePublishFrontmatterSelection(ref, docName);
  return (
    <div ref={ref} data-testid="panel">
      <textarea data-testid="value" defaultValue="a long description value" />
      <span data-testid="static">static value text</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  publishSelectionContext('notes', 'frontmatter', null);
});

describe('usePublishFrontmatterSelection', () => {
  test('a highlight inside a property textarea publishes a frontmatter snapshot', () => {
    const { getByTestId } = render(<Harness docName="notes" />);
    const ta = getByTestId('value') as HTMLTextAreaElement;
    act(() => {
      ta.focus();
      // "a long description value" — highlight "long description" (offsets 2..18).
      ta.setSelectionRange(2, 18);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const snap = getSelectionContext('notes', 'frontmatter');
    expect(snap).not.toBeNull();
    expect(snap?.surface).toBe('frontmatter');
    expect(snap?.markdown).toBe('long description');
  });

  test('a collapsed selection clears the frontmatter entry', () => {
    const { getByTestId } = render(<Harness docName="notes" />);
    const ta = getByTestId('value') as HTMLTextAreaElement;
    act(() => {
      ta.focus();
      ta.setSelectionRange(2, 17);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(getSelectionContext('notes', 'frontmatter')).not.toBeNull();

    act(() => {
      // Collapse the selection.
      ta.setSelectionRange(5, 5);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(getSelectionContext('notes', 'frontmatter')).toBeNull();
  });

  test('a DOM Range over a static value display also publishes', () => {
    const { getByTestId } = render(<Harness docName="notes" />);
    const staticNode = getByTestId('static');
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(staticNode);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const snap = getSelectionContext('notes', 'frontmatter');
    expect(snap?.surface).toBe('frontmatter');
    expect(snap?.markdown).toContain('static value text');
  });

  test('unmount clears the doc frontmatter entry', () => {
    const { getByTestId, unmount } = render(<Harness docName="notes" />);
    const ta = getByTestId('value') as HTMLTextAreaElement;
    act(() => {
      ta.focus();
      ta.setSelectionRange(0, 6);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(getSelectionContext('notes', 'frontmatter')).not.toBeNull();
    unmount();
    expect(getSelectionContext('notes', 'frontmatter')).toBeNull();
  });
});
