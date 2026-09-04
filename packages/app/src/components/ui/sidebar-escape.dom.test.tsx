import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SidebarProvider } from './sidebar';

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
      {}
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

    screen
      .getByTestId('editor')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('Escape inside a form control belongs to that control, not the sidebar', () => {
    const onOpenChange = vi.fn();
    renderNarrowSidebar(onOpenChange);

    screen
      .getByTestId('field')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
