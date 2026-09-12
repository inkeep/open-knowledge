// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TerminalStartingNotice } from './TerminalStartingNotice';

describe('TerminalStartingNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('shows only the spinner label while the wait is still normal', () => {
    render(<TerminalStartingNotice />);
    expect(screen.getByTestId('terminal-starting-notice').getAttribute('data-slow')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('explains itself and offers recovery once the wait becomes abnormal', async () => {
    render(<TerminalStartingNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId('terminal-starting-notice').getAttribute('data-slow')).toBe('true');
    expect(screen.getByRole('button')).toBeTruthy();
  });

  test('escalates inside the region that already existed, minting no new one', async () => {
    const { container } = render(<TerminalStartingNotice />);
    const regionsBefore = [...container.querySelectorAll('[role="status"]')];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    const regions = [...container.querySelectorAll('[role="status"]')];
    expect(regions.length).toBe(regionsBefore.length);
    for (const [index, region] of regions.entries()) {
      expect(region).toBe(regionsBefore[index]);
    }
    const escalation = screen.getByText(/taking longer than usual/);
    expect(regions.some((region) => region.contains(escalation))).toBe(true);
    expect(regions.some((region) => region.contains(screen.getByRole('button')))).toBe(false);
  });

  test('keeps waiting rather than replacing the panel with a dead end', async () => {
    render(<TerminalStartingNotice />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('terminal-starting-notice')).toBeTruthy();
  });
});
