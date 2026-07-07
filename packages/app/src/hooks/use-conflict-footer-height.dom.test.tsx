/**
 * tests for `useConflictFooterHeightVar`'s ownership token — the
 * guard that keeps a stale hook instance (unmounting AFTER a newer conflict
 * surface claimed the var) from blanking `--conflict-footer-height` and
 * re-introducing the composer-covers-conflict-controls occlusion.
 *
 * Substrate: jsdom via `bun run test:dom`. jsdom performs no layout, so
 * every published value is '0px' — these are lifecycle/ownership pins, not
 * geometry assertions (real heights are covered by the browser).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { useConflictFooterHeightVar } from './use-conflict-footer-height';

function Footer({ enabled = true }: { enabled?: boolean }) {
  const ref = useConflictFooterHeightVar(enabled);
  return <div ref={ref} />;
}

function getVar() {
  return document.documentElement.style.getPropertyValue('--conflict-footer-height');
}

describe('useConflictFooterHeightVar ownership', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty('--conflict-footer-height');
  });

  test('publishes while enabled and removes on unmount', () => {
    const { unmount } = render(<Footer />);
    expect(getVar()).toBe('0px'); // jsdom: offsetHeight=0
    unmount();
    expect(getVar()).toBe('');
  });

  test('a stale instance unmounting after a newer publisher does not clear the var', () => {
    const first = render(<Footer />);
    render(<Footer />);
    first.unmount();
    expect(getVar()).toBe('0px');
  });

  test('disabled instances neither publish nor claim ownership', () => {
    render(<Footer enabled={false} />);
    expect(getVar()).toBe('');
  });
});
