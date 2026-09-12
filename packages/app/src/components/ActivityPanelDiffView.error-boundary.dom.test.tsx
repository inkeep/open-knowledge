// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.doMock('@pierre/diffs/react', () => ({
  MultiFileDiff: () => {
    throw new Error('Pierre render blew up');
  },
}));

const { ActivityPanelDiffView } = await import('./ActivityPanelDiffView');

const BEFORE = 'line one\noriginal line\n';
const AFTER = 'line one\nchanged line\n';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ActivityPanelDiffView — Pierre render failure', () => {
  test('falls back to the raw after-text instead of taking the panel down', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(
      <ActivityPanelDiffView before={BEFORE} after={AFTER} cacheKey="doc@v1" />,
    );

    expect(container.querySelector('diffs-container')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(AFTER);
    expect(
      consoleError.mock.calls.some(
        (args) => args[0] === '[activity-panel-diff] Pierre render failed',
      ),
    ).toBe(true);
  });
});
