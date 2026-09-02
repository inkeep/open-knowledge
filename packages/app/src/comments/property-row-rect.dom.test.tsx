import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { findPropertyRow, propertyRowRect } from './property-row-rect';

function Rows({ keys }: { keys: readonly string[] }) {
  return (
    <>
      {keys.map((key) => (
        <div key={key} data-testid="property-row" data-key={key} />
      ))}
    </>
  );
}

function stubRect(key: string, rect: Partial<DOMRect> = {}): void {
  const el = findPropertyRow(key);
  if (el === null) throw new Error(`no row rendered for ${key}`);
  el.getBoundingClientRect = () =>
    ({ top: 100, height: 24, width: 300, ...rect }) as unknown as DOMRect;
}

afterEach(() => cleanup());

describe('locating a property row', () => {
  test('finds the row for its key', () => {
    render(<Rows keys={['title', 'tags']} />);
    stubRect('tags');
    expect(findPropertyRow('tags')).not.toBeNull();
    expect(propertyRowRect('tags')?.top).toBe(100);
  });

  test('a key with no row has no position', () => {
    render(<Rows keys={['tags']} />);
    expect(propertyRowRect('date')).toBeNull();
  });

  test('a zero-size row counts as absent', () => {
    render(<Rows keys={['tags']} />);
    stubRect('tags', { top: 0, height: 0, width: 0 });
    expect(propertyRowRect('tags')).toBeNull();
  });

  test('does not match a row belonging to a different key', () => {
    render(<Rows keys={['tags']} />);
    expect(findPropertyRow('tag')).toBeNull();
  });

  test('an empty key never matches', () => {
    render(<Rows keys={['tags']} />);
    expect(findPropertyRow('')).toBeNull();
  });
});
