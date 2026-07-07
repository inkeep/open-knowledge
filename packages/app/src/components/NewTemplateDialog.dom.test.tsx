/**
 * DOM tests for NewTemplateDialog's dismiss behavior. Runs under jsdom via
 * `bun run test:dom`.
 *
 * Regression: dismissing the form (the "x" close button, Cancel) must not
 * surface the field-validation errors. On open, Radix focuses the Name input;
 * pressing a dismiss control blurs it, and the blur-driven `titleTouched`
 * reveal renders the required-name + filename-grammar errors. In a real
 * browser that growth re-centers the dialog and slides the close target out
 * from under the pointer between mousedown and mouseup, eating the first click
 * (the user has to click twice). jsdom can't reproduce the layout shift, but it
 * can pin the foundational invariant the shift rides on: a dismiss press must
 * not perturb the form's validation state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewTemplateDialog } from './NewTemplateDialog';

// Radix Dialog (focus-trap) reaches for DOM globals the shared jsdom preload
// doesn't expose. Hoist the needed shims locally — same pattern as
// CloneDialog.dom.test.tsx / SettingsDialogShell.dom.test.tsx.
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
  // `open` stays true regardless of the close request so the form body stays
  // mounted and its validation state is observable after the dismiss press.
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

    // Model Radix's open-autofocus: focus lands on the Name field.
    const nameInput = screen.getByTestId('template-name-input');
    nameInput.focus();
    expect(screen.queryByText('Enter a name for this template.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    // The dismiss is requested on the first click...
    expect(openChanges()).toContain(false);
    // ...without surfacing the field errors the user never triggered.
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
