import { act, render, waitForElementToBeRemoved } from '@testing-library/react';
import { type ReactNode, Suspense } from 'react';
import { vi } from 'vitest';

export async function renderSettingsBody(content: ReactNode) {
  const view = render(
    <Suspense fallback={<span data-testid="settings-render-pending" />}>{content}</Suspense>,
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const pending = view.queryByTestId('settings-render-pending');
  if (pending) await waitForElementToBeRemoved(pending);
  return view;
}
