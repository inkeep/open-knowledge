import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test } from 'vitest';
import { useFindInViewer } from './use-find-in-viewer';

function FindHarness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { findOpen } = useFindInViewer(rootRef);
  return (
    <>
      <a href="#sidebar-target" data-testid="sidebar-target">
        Sidebar target
      </a>
      <div ref={rootRef}>{findOpen ? 'find-open' : 'find-closed'}</div>
    </>
  );
}

describe('useFindInViewer', () => {
  test('opens find when focus remains outside the active viewer', () => {
    render(<FindHarness />);
    const sidebarTarget = screen.getByTestId('sidebar-target');
    sidebarTarget.focus();

    const event = createEvent.keyDown(sidebarTarget, {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(sidebarTarget, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('find-open')).toBeDefined();
  });

  test('does not take find from an external editable control', () => {
    render(<FindHarness />);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    const event = createEvent.keyDown(input, {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByText('find-closed')).toBeDefined();
    input.remove();
  });
});
