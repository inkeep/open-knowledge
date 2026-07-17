/**
 * Behavioral tests for the filtered-to-zero tree notice: the reset action's
 * config payload (tree-content toggles to defaults, Skills section untouched),
 * the disabled state while the project-local binding is unavailable, and the
 * rejection toast — the same write-path contract as every other sidebar
 * visibility surface.
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

let projectLocalBindingNull = false;
let patchResultOk = true;
const patchCalls: unknown[] = [];
const toastErrors: unknown[][] = [];

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: null,
    projectLocalBinding: projectLocalBindingNull
      ? null
      : {
          patch: (value: unknown) => {
            patchCalls.push(value);
            return patchResultOk
              ? { ok: true, appliedPaths: [], effective: {} }
              : { ok: false, error: { issues: [] } };
          },
        },
  }),
}));

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrors.push(args),
    success: () => {},
  },
}));

const { FileTreeFilteredToZeroNotice } = await import('./FileTreeFilteredToZeroNotice');

const resetButton = () => screen.queryByTestId('reset-view-filters');

describe('FileTreeFilteredToZeroNotice', () => {
  beforeEach(() => {
    projectLocalBindingNull = false;
    patchResultOk = true;
    patchCalls.length = 0;
    toastErrors.length = 0;
  });

  afterEach(() => cleanup());

  test('explains the state and offers the reset action', () => {
    render(<FileTreeFilteredToZeroNotice />);

    expect(screen.queryByTestId('file-tree-filtered-to-zero')).toBeTruthy();
    expect(screen.queryByText('All files are hidden by view filters.')).toBeTruthy();
    expect(resetButton()).toBeTruthy();
  });

  test('reset restores the tree-content toggles to defaults and leaves the Skills section alone', () => {
    render(<FileTreeFilteredToZeroNotice />);

    fireEvent.click(resetButton() as HTMLElement);
    expect(patchCalls).toEqual([
      {
        appearance: {
          sidebar: {
            showHiddenFiles: false,
            showOnlyMarkdownFiles: false,
            showOkFolders: false,
          },
        },
      },
    ]);
  });

  test('reset is disabled while the project-local binding is unavailable', () => {
    projectLocalBindingNull = true;
    render(<FileTreeFilteredToZeroNotice />);

    expect((resetButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(resetButton() as HTMLElement);
    expect(patchCalls).toEqual([]);
  });

  test('a rejected patch surfaces the shared settings toast', () => {
    patchResultOk = false;
    render(<FileTreeFilteredToZeroNotice />);

    fireEvent.click(resetButton() as HTMLElement);
    expect(toastErrors.length).toBe(1);
    expect(toastErrors[0]?.[0]).toBe('Could not update sidebar settings');
  });
});
