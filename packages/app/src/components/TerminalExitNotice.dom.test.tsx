import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TerminalExitNotice } from './TerminalExitNotice';

afterEach(() => cleanup());

describe('TerminalExitNotice', () => {
  test('a clean exit shows the ended state inside an alert live region', () => {
    render(<TerminalExitNotice info={{ exitCode: 0, signal: null }} onRestart={() => {}} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/terminal session ended/i)).toBeTruthy();
  });

  test('a non-zero exit code is conveyed so the state is actionable', () => {
    render(<TerminalExitNotice info={{ exitCode: 1, signal: null }} onRestart={() => {}} />);
    expect(screen.getByText(/exit code 1/)).toBeTruthy();
  });

  test('a signal termination is conveyed and takes precedence over the exit code', () => {
    render(<TerminalExitNotice info={{ exitCode: 0, signal: 9 }} onRestart={() => {}} />);
    expect(screen.getByText(/signal 9/)).toBeTruthy();
  });

  test('a crash is distinguished from a clean exit', () => {
    render(
      <TerminalExitNotice
        info={{ exitCode: 1, signal: null, error: 'host crashed' }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/stopped unexpectedly/i)).toBeTruthy();
    expect(screen.queryByText(/host crashed/)).toBeNull();
  });

  test('the restart control is an accessible button that spawns a fresh session', () => {
    const onRestart = mock(() => {});
    render(<TerminalExitNotice info={{ exitCode: 0, signal: null }} onRestart={onRestart} />);

    const restart = screen.getByRole('button', { name: 'Restart terminal' });
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
