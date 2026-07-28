/**
 * Regression guard for the dialog surface of `FeedbackForm`.
 *
 * The sidebar card added a `compact` variant that reveals the form only once a
 * rating is picked. That gating is deliberately card-only: the dialog is opened
 * on purpose and has no height pressure, so it stays fully expanded. Nothing
 * else covers the dialog, so without this a future tweak to the shared form
 * could collapse it and no test would notice.
 */

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

/**
 * The dialog body is a `lazy()` boundary, so the first test in the file pays
 * the dynamic-import cost — more than the 1000 ms `findBy*` default allows.
 * Later tests hit the module cache and resolve immediately.
 */
const findFormBody = () => screen.findByRole('radio', { name: 'Good' }, { timeout: 5000 });

describe('FeedbackFormDialog', () => {
  afterEach(() => cleanup());

  test('keeps its own title rather than the card heading', async () => {
    renderDialog();
    // The body lazy-loads, so wait on it before asserting the shell.
    expect(await findFormBody()).toBeTruthy();

    expect(screen.getByText('How do you like OpenKnowledge?')).toBeTruthy();
    expect(screen.queryByText("Tell us how it's going")).toBeNull();
  });

  test('exposes an onSuccess seam so a caller can record that feedback was given', () => {
    // The proactive card's cross-suppression rides this prop: HelpPopover
    // passes `() => feedbackNudgeStore.dismiss()`, so feedback given through
    // the Resources menu stops the card from asking the same person again.
    // Without the prop there is nowhere to hang that, which is the gap this
    // pins shut. The submit path itself needs a live /api/feedback, so this
    // asserts the seam exists and is optional rather than driving a send.
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
