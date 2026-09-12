import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TerminalExitNotice } from './TerminalExitNotice';

afterEach(() => cleanup());

describe('TerminalExitNotice', () => {
  test('a clean exit shows the ended state inside an alert live region', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'exit', exitCode: 0, signal: null }}
        onRestart={() => {}}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/terminal session ended/i)).toBeTruthy();
  });

  test('a non-zero exit code is conveyed so the state is actionable', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'exit', exitCode: 1, signal: null }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/exit code 1/)).toBeTruthy();
  });

  test('a signal termination is conveyed and takes precedence over the exit code', () => {
    render(
      <TerminalExitNotice info={{ phase: 'exit', exitCode: 0, signal: 9 }} onRestart={() => {}} />,
    );
    expect(screen.getByText(/signal 9/)).toBeTruthy();
  });

  test('a crash is distinguished from a clean exit', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'exit', exitCode: 1, signal: null, error: 'host crashed' }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/stopped unexpectedly/i)).toBeTruthy();
    expect(screen.queryByText(/host crashed/)).toBeNull();
  });

  test('a host process death is distinguished from a clean exit', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'exit', exitCode: 1, signal: null, hostExited: true }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/stopped unexpectedly/i)).toBeTruthy();
  });

  test('a shell that never started is distinguished from one that ran and died', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'start', reason: 'host-unavailable' }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't start/i)).toBeTruthy();
    expect(screen.getByText(/background service isn't running/i)).toBeTruthy();
    expect(screen.queryByText('host-unavailable')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/stopped unexpectedly/i)).toBeNull();
  });

  test('a real spawn error is shown verbatim rather than translated away', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'start', detail: 'posix_spawnp failed' }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't start/i)).toBeTruthy();
    expect(screen.getByText('posix_spawnp failed')).toBeTruthy();
  });

  test('a launch composition failure reads as localized copy, never as the machine reason', () => {
    render(
      <TerminalExitNotice
        info={{ phase: 'start', reason: 'launch-unsupported' }}
        onRestart={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't start/i)).toBeTruthy();
    expect(screen.getByText(/can't run this command in the configured shell/i)).toBeTruthy();
    expect(screen.queryByText(/unsafe-argument|unsupported-shell|invalid-launch/)).toBeNull();
  });

  test('the restart control is an accessible button that spawns a fresh session', () => {
    const onRestart = vi.fn(() => {});
    render(
      <TerminalExitNotice
        info={{ phase: 'exit', exitCode: 0, signal: null }}
        onRestart={onRestart}
      />,
    );

    const restart = screen.getByRole('button', { name: 'Restart terminal' });
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
