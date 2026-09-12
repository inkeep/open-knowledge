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

  test('the reserved-log advisory switch is on by default', () => {
    render(<ContentRulesSection />);
    const toggle = screen.getByRole('switch', { name: 'Ignore broken links in log.md' });
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });

  test('a persisted off value renders the reserved-log switch unchecked', () => {
    projectConfigValue = { validation: { suppressLogLinkAdvisories: false } };
    render(<ContentRulesSection />);
    expect(screen.getByTestId('settings-content-rules-log-links').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  test('turning the reserved-log switch off writes a validation patch', () => {
    render(<ContentRulesSection />);
    fireEvent.click(screen.getByTestId('settings-content-rules-log-links'));
    expect(patches).toEqual([{ validation: { suppressLogLinkAdvisories: false } }]);
  });

  test('the reserved-log description names both reserved extensions and the raw views', () => {
    render(<ContentRulesSection />);
    const description = describedTextOf('settings-content-rules-log-links');
    expect(description).toContain('log.md');
    expect(description).toContain('log.mdx');
    expect(description).toContain('Links panel');
    expect(description).toContain('file explorer indicators');
    expect(description).toContain('at any folder depth');
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
      ['settings-content-rules-log-links', 'not the file it points at'],
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
    fireEvent.click(screen.getByTestId('settings-content-rules-links'));
    fireEvent.click(screen.getByRole('option', { name: 'Error' }));
    expect(patches).toEqual([{ validation: { links: 'error' } }]);
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('the reserved-log switch is not operable while the project config is still loading', () => {
    projectSyncedValue = false;
    render(<ContentRulesSection />);
    const toggle = screen.getByTestId('settings-content-rules-log-links');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    fireEvent.click(toggle);
    expect(patches).toEqual([]);
  });

  test('a failed reserved-log patch keeps the last confirmed value on screen', () => {
    patchResult = { ok: false, error: 'nope' };
    render(<ContentRulesSection />);
    fireEvent.click(screen.getByTestId('settings-content-rules-log-links'));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-content-rules-log-links').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  test('a project-config change made elsewhere moves the reserved-log switch', () => {
    const { rerender } = render(<ContentRulesSection />);
    expect(screen.getByTestId('settings-content-rules-log-links').getAttribute('data-state')).toBe(
      'checked',
    );
    projectConfigValue = { validation: { suppressLogLinkAdvisories: false } };
    rerender(<ContentRulesSection />);
    expect(screen.getByTestId('settings-content-rules-log-links').getAttribute('data-state')).toBe(
      'unchecked',
    );
    expect(patches).toEqual([]);
  });

  test('a failed patch surfaces an error toast', () => {
    patchResult = { ok: false, error: 'nope' };
    render(<ContentRulesSection />);
    fireEvent.click(screen.getByTestId('settings-content-rules-indicators'));
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
