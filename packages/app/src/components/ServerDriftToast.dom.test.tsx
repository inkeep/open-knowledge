import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ServerDriftToast } from '@/components/ServerDriftToast';

afterEach(cleanup);

const baseProps = {
  body: 'This project is running an older version of OpenKnowledge (v0.8.0) than this app (v0.8.2).',
  warning:
    'Restarting closes this project server. Connected agents will see their OpenKnowledge MCP connection close unexpectedly.',
  restartLabel: "Restart with this app's version",
  cancelLabel: 'Not now',
};

describe('ServerDriftToast', () => {
  test('renders the body, the full warning, and both buttons', () => {
    render(<ServerDriftToast {...baseProps} onRestart={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(baseProps.body)).toBeDefined();
    // The full warning renders as a single text node (it must not collapse to a
    // per-word column the way sonner's built-in description layout did).
    expect(screen.getByText(baseProps.warning)).toBeDefined();
    expect(screen.getByRole('button', { name: baseProps.restartLabel })).toBeDefined();
    expect(screen.getByRole('button', { name: baseProps.cancelLabel })).toBeDefined();
  });

  test('the restart button calls onRestart', () => {
    const onRestart = mock(() => {});
    render(<ServerDriftToast {...baseProps} onRestart={onRestart} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: baseProps.restartLabel }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  test('the cancel button calls onDismiss', () => {
    const onDismiss = mock(() => {});
    render(<ServerDriftToast {...baseProps} onRestart={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: baseProps.cancelLabel }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
