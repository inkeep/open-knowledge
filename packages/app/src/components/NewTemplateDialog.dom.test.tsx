import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NewTemplateDialog } from './NewTemplateDialog';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

function renderDialog() {
  const openChanges: boolean[] = [];
  render(
    <NewTemplateDialog
      folderPath=""
      existingNames={new Set()}
      open
      onOpenChange={(next) => openChanges.push(next)}
      onCreated={() => {}}
    />,
  );
  return { openChanges: () => openChanges };
}

describe('NewTemplateDialog — dismissing an untouched form', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test('clicking the close button does not surface validation errors', async () => {
    const user = userEvent.setup();
    const { openChanges } = renderDialog();

    const nameInput = screen.getByTestId('template-name-input');
    nameInput.focus();
    expect(screen.queryByText('Enter a name for this template.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(openChanges()).toContain(false);
    expect(screen.queryByText('Enter a name for this template.')).toBeNull();
    expect(screen.queryByText(/Use letters, digits/)).toBeNull();
  });

  test('clicking Cancel does not surface validation errors', async () => {
    const user = userEvent.setup();
    const { openChanges } = renderDialog();

    const nameInput = screen.getByTestId('template-name-input');
    nameInput.focus();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(openChanges()).toContain(false);
    expect(screen.queryByText('Enter a name for this template.')).toBeNull();
    expect(screen.queryByText(/Use letters, digits/)).toBeNull();
  });
});
