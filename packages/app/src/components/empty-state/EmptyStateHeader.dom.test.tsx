import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@/components/OkBlob', () => ({
  OkBlob: ({ celebrateSignal, size }: { celebrateSignal: number; size: number }) => (
    <div
      data-testid="ok-blob-probe"
      data-celebrate-signal={String(celebrateSignal)}
      data-size={String(size)}
    />
  ),
}));

describe('EmptyStateHeader runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports EmptyStateHeader component', async () => {
    const mod = await import('./EmptyStateHeader');
    expect(typeof mod.EmptyStateHeader).toBe('function');
  });

  test('renders title, optional subtitle, block-level row layout, and blob signal', async () => {
    const { EmptyStateHeader } = await import('./EmptyStateHeader');

    const { rerender } = render(
      <EmptyStateHeader title="Choose a starter" subtitle="Pick one" celebrateSignal={3} />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Choose a starter' })).toBeTruthy();
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-celebrate-signal')).toBe('3');
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-size')).toBe('64');

    const root = screen.getByTestId('ok-blob-probe').parentElement;
    expectVisualClassTokens(root?.className, ['flex', 'items-center', 'gap-4']);
    expectVisualClassTokensAbsent(root?.className, ['inline-flex']);

    rerender(<EmptyStateHeader title="Choose a starter" celebrateSignal={4} />);

    expect(screen.queryByText('Pick one')).toBeNull();
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-celebrate-signal')).toBe('4');
  });
});
