/**
 * Placing a comment that has no ProseMirror position.
 *
 * A property thread is the one comment the editor cannot locate for us, so the
 * rail and the popover resolve it through the DOM instead. These pin the two
 * cases that decide whether a marker appears at all: a row that is on screen,
 * and a row that is not rendered (collapsed disclosure, deleted key), where the
 * answer has to be "no position" rather than a fallback.
 *
 * Mounted rather than hand-built from `document.createElement`: the helper's
 * whole job is to find rows the property panel rendered, so the fixture carries
 * the same `data-testid` / `data-key` pair `FrontmatterRow` emits.
 */

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

/**
 * jsdom lays nothing out, so every rect is zero — which this helper reads as
 * "not on screen". Stub the row under test so the positive cases exercise the
 * real branch rather than the absent one.
 */
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
    // The disclosure is collapsed, or the key was removed. Callers skip — a
    // marker pinned to an arbitrary y is worse than an absent one.
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
