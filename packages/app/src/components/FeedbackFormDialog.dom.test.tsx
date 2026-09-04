import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FeedbackFormDialog } from './FeedbackFormDialog';

function renderDialog(props: Partial<React.ComponentProps<typeof FeedbackFormDialog>> = {}) {
  render(
    <TooltipProvider>
      <FeedbackFormDialog open onOpenChange={() => {}} source="test" {...props} />
    </TooltipProvider>,
  );
}

const findFormBody = () => screen.findByRole('radio', { name: 'Good' }, { timeout: 5000 });

describe('FeedbackFormDialog', () => {
  afterEach(() => cleanup());

  test('keeps its own title rather than the card heading', async () => {
    renderDialog();
    expect(await findFormBody()).toBeTruthy();

    expect(screen.getByText('How do you like OpenKnowledge?')).toBeTruthy();
    expect(screen.queryByText("Tell us how it's going")).toBeNull();
  });

  test('exposes an onSuccess seam so a caller can record that feedback was given', () => {
    expect(() => renderDialog({ onSuccess: () => {} })).not.toThrow();
    expect(() => renderDialog()).not.toThrow();
  });

  test('renders the whole form up front, with no rating picked', async () => {
    renderDialog();
    await findFormBody();

    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Tell us more (optional)')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Share your email for followups' })).toBeTruthy();
  });
});
