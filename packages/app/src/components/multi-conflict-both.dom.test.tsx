import { act, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConflictView } from './ConflictView';

const side = (pilot: string, owner: string) =>
  `# Launch checklist\n\n## Now\n\n${pilot}\n\n- Owner: ${owner}\n- Status: in review\n`;

const OURS = side('We open the pilot once docs and a rollback plan are ready.', 'Marcus Webb');
const BASE = side('We open the pilot once docs are ready.', 'Sam Ford');
const THEIRS = side(
  'We open the pilot once docs, the guide, and coverage are ready.',
  'Priya Raman',
);

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function renderView(onResolve = vi.fn()) {
  render(
    <ConflictView
      fileName="notes/launch-checklist.md"
      ours={OURS}
      base={BASE}
      theirs={THEIRS}
      onResolve={onResolve}
    />,
  );
  return onResolve;
}

const rows = () => screen.queryAllByRole('button', { name: /^Accept current/ }).length;

async function clickAll(name: string) {
  const byLabel = new RegExp(`^${name}`);
  for (let i = 0; i < 6; i++) {
    const btns = screen.queryAllByRole('button', { name: byLabel });
    if (btns.length === 0) break;
    btns[0].click();
    await settle();
  }
}

describe('multi-conflict resolution', () => {
  test('accepting both on every conflict writes no markers and loses no content', async () => {
    const onResolve = renderView();
    await settle();
    await clickAll('Accept both');

    screen.getByRole('button', { name: 'Apply changes' }).click();
    await settle();

    const resolved = onResolve.mock.calls[0][0] as string;
    expect(resolved).not.toMatch(/^(<{7} |={7}$|>{7} |\|{7} )/m);
    expect(resolved).toContain('Marcus Webb');
    expect(resolved).toContain('Priya Raman');
    expect(resolved).toContain('a rollback plan are ready.');
    expect(resolved).toContain('coverage are ready.');
  });

  test('undo and redo unwind every conflict, including from fully resolved', async () => {
    renderView();
    await settle();
    expect(rows()).toBe(2);

    await clickAll('Accept current');
    expect(rows()).toBe(0);

    const undone: number[] = [];
    for (let i = 0; i < 2; i++) {
      screen.getByRole('button', { name: 'Undo' }).click();
      await settle();
      undone.push(rows());
    }
    expect(undone).toEqual([1, 2]);

    const redone: number[] = [];
    for (let i = 0; i < 2; i++) {
      screen.getByRole('button', { name: 'Redo' }).click();
      await settle();
      redone.push(rows());
    }
    expect(redone).toEqual([1, 0]);
  });
});
