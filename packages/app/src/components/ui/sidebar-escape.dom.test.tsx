import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SidebarProvider } from './sidebar';

// Below LEFT_COLLAPSE_THRESHOLD (1024), so `partition` resolves to 'below' and
// the Escape-dismisses-the-sidebar listener is live. Above it the listener never
// subscribes and there is nothing to collide with.
const NARROW_VIEWPORT = 800;

let originalInnerWidth: number;

beforeEach(() => {
  originalInnerWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: NARROW_VIEWPORT,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  cleanup();
});

function renderNarrowSidebar(onOpenChange: (open: boolean) => void) {
  return render(
    <SidebarProvider open onOpenChange={onOpenChange}>
      <textarea data-testid="field" aria-label="a text field" />
      {/* Stand-in for the ProseMirror document surface, which is contentEditable. */}
      <div data-testid="editor" contentEditable suppressContentEditableWarning />
      <div data-testid="plain">not a text surface</div>
    </SidebarProvider>,
  );
}

describe('sidebar Escape dismissal', () => {
  test('Escape from a plain element still collapses the sidebar', () => {
    const onOpenChange = vi.fn();
    renderNarrowSidebar(onOpenChange);

    screen
      .getByTestId('plain')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Escape from the document editor still collapses the sidebar', () => {
    const onOpenChange = vi.fn();
    renderNarrowSidebar(onOpenChange);

    // contentEditable is deliberately outside the guard. The editor binds no
    // Escape of its own, and dismissing chrome from the main work surface is
    // intended: an e2e clicks into the ProseMirror surface and then presses
    // Escape expecting the sidebar to close. Guarding contentEditable broke it.
    screen
      .getByTestId('editor')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Escape inside a form control belongs to that control, not the sidebar', () => {
    const onOpenChange = vi.fn();
    renderNarrowSidebar(onOpenChange);

    // The listener is capture-phase on window, so it sees this before any
    // field-scoped handler can preventDefault — the target is the only signal
    // available to tell the two apart. Without the guard, stopping an agent turn
    // with Escape in the composer would also collapse unrelated chrome.
    screen
      .getByTestId('field')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
