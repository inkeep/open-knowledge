import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ServerDriftToast } from '@/components/ServerDriftToast';

afterEach(cleanup);

const baseProps = {
  body: 'This project is running an older version of OpenKnowledge (v0.8.0) than this app (v0.8.2).',
  detail:
    'Restarting closes this project server. Connected agents will see their OpenKnowledge MCP connection close unexpectedly.',
  actionLabel: "Restart with this app's version",
  dismissLabel: 'Not now',
};

describe('ServerDriftToast', () => {
  test('renders the body, the full detail, and both buttons', () => {
    render(<ServerDriftToast {...baseProps} onAction={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(baseProps.body)).toBeDefined();
    expect(screen.getByText(baseProps.detail)).toBeDefined();
    expect(screen.getByRole('button', { name: baseProps.actionLabel })).toBeDefined();
    expect(screen.getByRole('button', { name: baseProps.dismissLabel })).toBeDefined();
  });

  test('the action button calls onAction', () => {
    const onAction = vi.fn(() => {});
    render(<ServerDriftToast {...baseProps} onAction={onAction} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: baseProps.actionLabel }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test('the cancel button calls onDismiss', () => {
    const onDismiss = vi.fn(() => {});
    render(<ServerDriftToast {...baseProps} onAction={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: baseProps.dismissLabel }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
