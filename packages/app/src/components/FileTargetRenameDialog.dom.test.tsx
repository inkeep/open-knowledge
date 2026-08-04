import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FileTargetRenameDialog } from './FileTargetRenameDialog';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

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

afterEach(cleanup);

describe('FileTargetRenameDialog', () => {
  test('shows the requested rename form and saves a valid name', () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn();
    render(
      <FileTargetRenameDialog
        currentName="notes.md"
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
      />,
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect((input as HTMLInputElement).value).toBe('notes.md');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

    fireEvent.change(input, { target: { value: 'renamed.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).toHaveBeenCalledWith('renamed.md');
  });

  test('keeps save disabled for unchanged or invalid names', () => {
    render(
      <FileTargetRenameDialog
        currentName="notes.md"
        open
        onOpenChange={() => {}}
        onSave={() => {}}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Name' });
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'nested/name.md' } });
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'valid.md' } });
    expect(save.disabled).toBe(false);
  });
});
