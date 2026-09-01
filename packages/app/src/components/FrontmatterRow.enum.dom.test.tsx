import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';

const globalWithDomShims = globalThis as { ResizeObserver?: unknown };
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const { FrontmatterRow } = await import('./FrontmatterRow.tsx');

beforeEach(() => {
  cleanup();
});

describe('FrontmatterRow enum widgets', () => {
  test('an enum constraint renders a single-select with the current value', () => {
    render(
      <FrontmatterRow
        keyName="status"
        value="review"
        declared="text"
        enumConstraint={{ values: ['draft', 'review', 'published'], multi: false }}
        onCommit={() => {}}
        onChangeType={() => {}}
      />,
    );
    const trigger = screen.getByTestId('property-enum-select');
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('review');
  });

  test('an items.enum constraint renders toggle chips committing the full array', () => {
    const commits: unknown[] = [];
    render(
      <FrontmatterRow
        keyName="tags"
        value={['a']}
        declared="list"
        enumConstraint={{ values: ['a', 'b'], multi: true }}
        onCommit={(next) => commits.push(next)}
        onChangeType={() => {}}
      />,
    );
    const optionB = screen.getByTestId('property-enum-option-b');
    expect(optionB.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(optionB);
    expect(commits).toEqual([['a', 'b']]);
    const optionA = screen.getByTestId('property-enum-option-a');
    expect(optionA.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(optionA);
    expect(commits[1]).toEqual([]);
  });

  test('an out-of-vocabulary current value stays visible in both widgets', () => {
    render(
      <FrontmatterRow
        keyName="status"
        value="shipped"
        declared="text"
        enumConstraint={{ values: ['draft', 'review'], multi: false }}
        onCommit={() => {}}
        onChangeType={() => {}}
      />,
    );
    expect(screen.getByTestId('property-enum-select').textContent).toContain('shipped');
    cleanup();
    render(
      <FrontmatterRow
        keyName="tags"
        value={['zzz']}
        declared="list"
        enumConstraint={{ values: ['a'], multi: true }}
        onCommit={() => {}}
        onChangeType={() => {}}
      />,
    );
    expect(screen.getByTestId('property-enum-option-zzz').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('no constraint keeps the free-text widget path unchanged', () => {
    render(
      <FrontmatterRow
        keyName="owner"
        value="serafin"
        declared="text"
        onCommit={() => {}}
        onChangeType={() => {}}
      />,
    );
    expect(screen.queryByTestId('property-enum-select')).toBeNull();
    expect(screen.queryByTestId('property-enum-multi')).toBeNull();
  });
});
