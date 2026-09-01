import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FeedbackCard, FeedbackCardMount } from './FeedbackCard';

function renderCard(onClose = vi.fn()) {
  render(
    <TooltipProvider>
      <FeedbackCard onClose={onClose} />
    </TooltipProvider>,
  );
  return { onClose };
}

describe('FeedbackCard', () => {
  afterEach(() => cleanup());

  test('renders the prompt and both rating choices inline (no dialog)', () => {
    renderCard();

    expect(screen.getByText("Tell us how it's going")).toBeTruthy();
    expect(screen.queryByText('How do you like OpenKnowledge?')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Good' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Not great' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('exposes a labelled landmark so the footer card is navigable', () => {
    renderCard();
    expect(screen.getByRole('region', { name: 'Share feedback' })).toBeTruthy();
  });

  test('mounts without a PageListProvider and renders nothing', () => {
    expect(() => render(<FeedbackCardMount />)).not.toThrow();
    expect(screen.queryByRole('region', { name: 'Share feedback' })).toBeNull();
  });

  test('the close button reports the dismissal', async () => {
    const user = userEvent.setup();
    const { onClose } = renderCard();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('shows only the rating until one is picked', () => {
    renderCard();

    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByPlaceholderText('Tell us more (optional)')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Share your email for followups' })).toBeNull();
  });

  test('reveals the rest of the form once a rating is picked', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('radio', { name: 'Good' }));

    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Tell us more (optional)')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Share your email for followups' })).toBeTruthy();
  });

  test('reason pills stay hidden until the negative rating is chosen', async () => {
    const user = userEvent.setup();
    renderCard();

    expect(screen.queryByText('What got in the way?')).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Not great' }));

    expect(screen.getByText('What got in the way?')).toBeTruthy();
    expect(screen.getByText('Too slow')).toBeTruthy();
  });

  test('switching back to Good drops the reason selection', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('radio', { name: 'Not great' }));
    await user.click(screen.getByRole('button', { name: 'Too slow' }));
    expect(screen.getByRole('button', { name: 'Too slow' }).dataset.state).toBe('on');

    await user.click(screen.getByRole('radio', { name: 'Good' }));
    expect(screen.queryByText('What got in the way?')).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Not great' }));
    expect(screen.getByRole('button', { name: 'Too slow' }).dataset.state).toBe('off');
  });
});
