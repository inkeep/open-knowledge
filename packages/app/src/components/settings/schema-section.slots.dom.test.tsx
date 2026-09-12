import type { Config } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

function translateLingui(
  message: TemplateStringsArray | string | { message?: string },
  ...values: unknown[]
): string {
  if (typeof message === 'object' && 'message' in message) return message.message ?? '';
  return renderLinguiTemplate(message, ...values);
}

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  msg: renderLinguiTemplate,
  useLingui: () => ({ t: translateLingui }),
}));
vi.doMock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn(), systemTheme: 'light' }),
}));

const { BoundSchemaSection } = await import('./schema-section');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const binding = {
  current: () => ({}) as Config,
  subscribe: () => () => {},
};

const FIELDS = [
  { path: ['appearance', 'theme'], label: renderLinguiTemplate`Theme`, control: 'theme-cards' },
  { path: ['editor', 'wordWrap'], label: renderLinguiTemplate`Word wrap` },
] as never;

function renderWithSlot(slotsAfter?: Record<string, ReactNode>) {
  return render(
    <TooltipProvider>
      <BoundSchemaSection
        title="Preferences"
        description="Customize how the editor looks and behaves."
        scope="user"
        scopeBadge="user"
        binding={binding as never}
        fields={FIELDS}
        slotsAfter={slotsAfter}
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('BoundSchemaSection slotsAfter', () => {
  test('renders the slot between its keyed field and the one that follows', () => {
    renderWithSlot({ 'appearance.theme': <div data-testid="slotted" /> });

    const theme = document.querySelector('[data-field="appearance.theme"]');
    const wordWrap = document.querySelector('[data-field="editor.wordWrap"]');
    const slotted = screen.getByTestId('slotted');
    expect(theme).not.toBeNull();
    expect(wordWrap).not.toBeNull();

    expect(theme?.compareDocumentPosition(slotted)).toBe(4);
    expect(slotted.compareDocumentPosition(wordWrap as Node) & 4).toBe(4);
  });

  test('a slot keyed to no field renders nothing rather than falling to the end', () => {
    renderWithSlot({ 'appearance.nonexistent': <div data-testid="slotted" /> });
    expect(screen.queryByTestId('slotted')).toBeNull();
  });

  test('fields render unchanged with no slots at all', () => {
    renderWithSlot();
    expect(document.querySelector('[data-field="appearance.theme"]')).not.toBeNull();
    expect(document.querySelector('[data-field="editor.wordWrap"]')).not.toBeNull();
  });
});
