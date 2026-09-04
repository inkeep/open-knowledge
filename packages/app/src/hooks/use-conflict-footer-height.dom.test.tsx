import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
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
    expect(getVar()).toBe('0px');
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
