import { I18nProvider } from '@lingui/react';
import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { i18n } from '@/lib/i18n';

function WithRealI18n({ children }: { children: ReactNode }) {
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}

export function renderWithI18n(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { ...options, wrapper: WithRealI18n });
}
