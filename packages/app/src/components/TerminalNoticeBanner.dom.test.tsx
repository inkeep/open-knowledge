import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '@/components/ui/button';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const { TerminalNoticeBanner } = await import('./TerminalNoticeBanner');

describe('TerminalNoticeBanner', () => {
  afterEach(cleanup);

  test('is a non-shrinking status strip with a stable test id', () => {
    render(
      <TerminalNoticeBanner testId="terminal-test-notice" onDismiss={() => {}}>
        Recoverable notice
      </TerminalNoticeBanner>,
    );
    const banner = screen.getByTestId('terminal-test-notice');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.className).toContain('shrink-0');
  });

  test('dismisses through the shared icon control', async () => {
    const onDismiss = vi.fn();
    render(
      <TerminalNoticeBanner testId="terminal-test-notice" onDismiss={onDismiss}>
        Recoverable notice
      </TerminalNoticeBanner>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test('offers only the dismiss control when no action is supplied', () => {
    render(
      <TerminalNoticeBanner testId="terminal-test-notice" onDismiss={() => {}}>
        Recoverable notice
      </TerminalNoticeBanner>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Dismiss');
  });

  test('renders a supplied action between the message and the dismiss control', () => {
    render(
      <TerminalNoticeBanner
        testId="terminal-test-notice"
        onDismiss={() => {}}
        action={<Button size="sm">Do the thing</Button>}
      >
        Recoverable notice
      </TerminalNoticeBanner>,
    );

    const message = screen.getByText('Recoverable notice');
    const action = screen.getByRole('button', { name: 'Do the thing' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });

    expect(message.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('an action click does not dismiss the notice', async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TerminalNoticeBanner
        testId="terminal-test-notice"
        onDismiss={onDismiss}
        action={
          <Button size="sm" onClick={onAction}>
            Do the thing
          </Button>
        }
      >
        Recoverable notice
      </TerminalNoticeBanner>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Do the thing' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
