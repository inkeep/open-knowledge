import type { UninstallProjectRow } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UninstallPickerScreen } from './UninstallPickerScreen';

const PROJECTS: readonly UninstallProjectRow[] = [
  { path: '/Users/dev/Notes', open: true, recent: true, running: true },
  { path: '/Users/dev/Work/Team Handbook', open: false, recent: true, running: false },
  { path: '/Users/dev/Personal/Journal', open: false, recent: true, running: false },
];

function renderPicker(projects: readonly UninstallProjectRow[] = PROJECTS) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<UninstallPickerScreen projects={projects} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel, user: userEvent.setup() };
}

function checkboxFor(path: string) {
  return screen.getByRole('checkbox', { name: `Remove OpenKnowledge from ${path}` });
}

describe('uninstall project picker', () => {
  afterEach(cleanup);

  test('lists every detected project with a single status badge', () => {
    renderPicker();

    expect(screen.getByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('0 / 3');
    for (const project of PROJECTS) {
      expect(checkboxFor(project.path)).toBeDefined();
    }

    const badges = screen.getAllByText(/^(active|recent)$/);
    expect(badges.map((el) => el.textContent)).toEqual(['active', 'recent', 'recent']);
  });

  test('nothing is selected until the user picks a project', () => {
    renderPicker();

    expect(screen.getByRole('status').textContent).toBe('0 / 3');
    for (const project of PROJECTS) {
      expect(checkboxFor(project.path).getAttribute('aria-checked')).toBe('false');
    }
  });

  test('the selected count follows what the user ticks and unticks', async () => {
    const { user } = renderPicker();

    await user.click(checkboxFor('/Users/dev/Notes'));
    expect(screen.getByRole('status').textContent).toBe('1 / 3');

    await user.click(checkboxFor('/Users/dev/Personal/Journal'));
    expect(screen.getByRole('status').textContent).toBe('2 / 3');

    await user.click(checkboxFor('/Users/dev/Notes'));
    expect(screen.getByRole('status').textContent).toBe('1 / 3');
  });

  test('the header checkbox selects every project, then clears them', async () => {
    const { user } = renderPicker();
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });

    await user.click(selectAll);
    for (const project of PROJECTS) {
      expect(checkboxFor(project.path).getAttribute('aria-checked')).toBe('true');
    }
    expect(selectAll.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('3 / 3');

    await user.click(selectAll);
    for (const project of PROJECTS) {
      expect(checkboxFor(project.path).getAttribute('aria-checked')).toBe('false');
    }
    expect(screen.getByRole('status').textContent).toBe('0 / 3');
  });

  test('the header checkbox is indeterminate when only some projects are ticked', async () => {
    const { user } = renderPicker();
    const selectAll = screen.getByRole('checkbox', { name: 'Select all' });

    await user.click(checkboxFor('/Users/dev/Notes'));
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed');
  });

  test('clicking a project row toggles its checkbox', async () => {
    const { user } = renderPicker();

    await user.click(screen.getByText('/Users/dev/Work/Team Handbook'));

    expect(checkboxFor('/Users/dev/Work/Team Handbook').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('1 / 3');
  });

  test('confirming reports the selected indexes in ascending order', async () => {
    const { user, onConfirm, onCancel } = renderPicker();

    await user.click(checkboxFor('/Users/dev/Personal/Journal'));
    await user.click(checkboxFor('/Users/dev/Notes'));
    await user.click(screen.getByRole('button', { name: 'Uninstall OpenKnowledge' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith([0, 2]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('confirming with nothing ticked reports an empty selection, not a cancel', async () => {
    const { user, onConfirm, onCancel } = renderPicker();

    await user.click(screen.getByRole('button', { name: 'Uninstall OpenKnowledge' }));

    expect(onConfirm).toHaveBeenCalledWith([]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('cancelling reports a cancel and never a selection', async () => {
    const { user, onConfirm, onCancel } = renderPicker();

    await user.click(checkboxFor('/Users/dev/Notes'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('Escape cancels', async () => {
    const { user, onCancel } = renderPicker();

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('the empty state explains that nothing was detected and can still be confirmed', async () => {
    const { user, onConfirm } = renderPicker([]);

    expect(
      screen.getByText('No active or recent OpenKnowledge projects were found.'),
    ).toBeDefined();
    expect(screen.queryByRole('checkbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Uninstall OpenKnowledge' }));
    expect(onConfirm).toHaveBeenCalledWith([]);
  });
});
