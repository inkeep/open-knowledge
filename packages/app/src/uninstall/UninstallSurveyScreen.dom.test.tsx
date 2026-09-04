import { UNINSTALL_FEEDBACK_REASONS } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UninstallSurveyScreen } from './UninstallSurveyScreen';

function renderSurvey() {
  const onSend = vi.fn();
  const onSkip = vi.fn();
  render(<UninstallSurveyScreen onSend={onSend} onSkip={onSkip} />);
  return { onSend, onSkip, user: userEvent.setup() };
}

function emailField(): HTMLInputElement {
  const field = screen.getByLabelText('Email address');
  if (!(field instanceof HTMLInputElement)) throw new Error('the email field is not an input');
  return field;
}

describe('uninstall churn survey', () => {
  afterEach(cleanup);

  test('offers every reason in the shared taxonomy, in its order and wording', () => {
    renderSurvey();

    expect(
      screen.getByRole('heading', { name: 'Thanks for giving OpenKnowledge a try.' }),
    ).toBeDefined();
    expect(screen.getByText('What you share is sent to the OpenKnowledge team.')).toBeDefined();

    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual(
      UNINSTALL_FEEDBACK_REASONS.map((option) => option.value),
    );
    for (const option of UNINSTALL_FEEDBACK_REASONS) {
      expect(screen.getByRole('radio', { name: option.label })).toBeDefined();
    }
  });

  test('nothing is answered until the user fills something in', async () => {
    const { user, onSend } = renderSurvey();

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.getAttribute('aria-checked')).toBe('false');
    }
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({});
  });

  test('sends the picked reason as its slug, not its label', async () => {
    const { user, onSend } = renderSurvey();

    await user.click(screen.getByRole('radio', { name: 'It was missing a feature I needed' }));
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({ reason: 'missing-feature' });
  });

  test('sends the note alongside the reason, trimmed', async () => {
    const { user, onSend } = renderSurvey();

    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.type(
      screen.getByLabelText("Anything you'd like to add? (optional)"),
      '  it lagged ',
    );
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({ reason: 'other', note: 'it lagged' });
  });

  test('a whitespace-only note is not an answer', async () => {
    const { user, onSend } = renderSurvey();

    await user.type(screen.getByLabelText("Anything you'd like to add? (optional)"), '   ');
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({});
  });

  test('the email field is hidden and disabled until the user opts in', () => {
    renderSurvey();

    const field = emailField();
    expect(field.disabled).toBe(true);
    expect(field.closest('[hidden]')).not.toBeNull();
  });

  test('opting in reveals, enables and focuses the email field', async () => {
    const { user } = renderSurvey();

    await user.click(screen.getByRole('checkbox', { name: 'Let us follow up by email' }));

    const field = emailField();
    expect(field.disabled).toBe(false);
    expect(field.closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  test('sends the address once the user has opted in', async () => {
    const { user, onSend } = renderSurvey();

    await user.click(screen.getByRole('checkbox', { name: 'Let us follow up by email' }));
    await user.type(emailField(), 'dev@example.com');
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({ email: 'dev@example.com' });
  });

  test('opting back out drops the address the user had typed', async () => {
    const { user, onSend } = renderSurvey();

    const optIn = screen.getByRole('checkbox', { name: 'Let us follow up by email' });
    await user.click(optIn);
    await user.type(emailField(), 'dev@example.com');
    await user.click(optIn);
    await user.click(screen.getByRole('button', { name: 'Send & continue' }));

    expect(onSend).toHaveBeenCalledWith({});
  });

  test('skipping answers nothing and never sends', async () => {
    const { user, onSend, onSkip } = renderSurvey();

    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test('has no cancel affordance — both buttons continue the uninstall', () => {
    renderSurvey();

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
