/**
 * Behavioral tests for the Content rules settings section (This project →
 * Content rules): the broken-link posture select and the file-tree indicator
 * toggle write `validation.*` patches through the project binding, defaults
 * read as warning/on, and the lint-plugins pointer is present.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { describedTextOf } from './settings-a11y.test-helper';

const linguiMacroMock = {
  t: renderLinguiTemplate,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: renderLinguiTemplate }),
};
vi.doMock('@lingui/core/macro', () => linguiMacroMock);
vi.doMock('@lingui/react/macro', () => linguiMacroMock);

let patches: unknown[] = [];
let patchResult: { ok: boolean; error?: unknown } = { ok: true };
let projectConfigValue: Record<string, unknown> = {};
let projectSyncedValue = true;
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig: projectConfigValue,
    projectSynced: projectSyncedValue,
    projectBinding: {
      patch: (patch: unknown) => {
        patches.push(patch);
        return patchResult;
      },
    },
  }),
}));

const toastError = vi.fn((_message: string) => {});
vi.doMock('sonner', () => ({ toast: { error: toastError } }));

const { ContentRulesSection } = await import('./ContentRulesSection');

beforeEach(() => {
  patches = [];
  patchResult = { ok: true };
  projectConfigValue = {};
  projectSyncedValue = true;
  toastError.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ContentRulesSection', () => {
  test('defaults read as links=warning and indicators on, with the plugins pointer', () => {
    render(<ContentRulesSection />);
    expect(screen.getByTestId('settings-content-rules-links').textContent).toContain('Warning');
    expect(screen.getByText(/missing project-local documents, files, and images/)).toBeTruthy();
    const toggle = screen.getByTestId('settings-content-rules-indicators');
    expect(toggle.getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('settings-content-rules-plugins-note').textContent).toContain(
      'their own tab',
    );
  });

  test('persisted values render: links=error, indicators off', () => {
    projectConfigValue = { validation: { links: 'error', fileTreeIndicators: false } };
    render(<ContentRulesSection />);
    expect(screen.getByTestId('settings-content-rules-links').textContent).toContain('Error');
    expect(screen.getByTestId('settings-content-rules-indicators').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  test('both controls are described by their own row description', () => {
    render(<ContentRulesSection />);
    for (const [testId, expected] of [
      [
        'settings-content-rules-links',
        'How missing project-local documents, files, and images are reported',
      ],
      ['settings-content-rules-indicators', 'Tint and badge files'],
    ] as const) {
      expect(describedTextOf(testId)).toContain(expected);
    }
  });

  test('toggling indicators writes a validation patch', () => {
    render(<ContentRulesSection />);
    fireEvent.click(screen.getByTestId('settings-content-rules-indicators'));
    expect(patches).toEqual([{ validation: { fileTreeIndicators: false } }]);
  });

  test('changing the links posture writes a validation patch', async () => {
    render(<ContentRulesSection />);
    // Radix Select in jsdom: open the trigger, then choose an option.
    fireEvent.click(screen.getByTestId('settings-content-rules-links'));
    fireEvent.click(screen.getByRole('option', { name: 'Error' }));
    expect(patches).toEqual([{ validation: { links: 'error' } }]);
    // Let the popup fully close before the test ends: Radix's focus-scope
    // dispatches from a timer, and a dispatch landing after this file's jsdom
    // window is torn down surfaces as a cross-file unhandled error.
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('a failed patch surfaces an error toast', () => {
    patchResult = { ok: false, error: 'nope' };
    render(<ContentRulesSection />);
    fireEvent.click(screen.getByTestId('settings-content-rules-indicators'));
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
