// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Calendar } from './calendar';

afterEach(() => {
  cleanup();
});

describe('Calendar', () => {
  test('renders a labelled month grid for the given month', () => {
    render(<Calendar month={new Date(2026, 0, 1)} />);
    const grid = screen.getByRole('grid');
    expect(grid).toBeTruthy();
    expect(screen.getAllByRole('gridcell').length).toBeGreaterThan(27);
  });

  test('styles the month grid through the month_grid slot, not the renamed table slot', () => {
    render(<Calendar month={new Date(2026, 0, 1)} />);
    const grid = screen.getByRole('grid');
    expect(grid.className).toContain('border-collapse');
    expect(grid.className).toContain('w-full');
    expect(grid.className).toContain('rdp-month_grid');
  });

  test('a caller can still override the month grid styling', () => {
    render(<Calendar month={new Date(2026, 0, 1)} classNames={{ month_grid: 'ok-custom-grid' }} />);
    expect(screen.getByRole('grid').className).toContain('ok-custom-grid');
  });
});
