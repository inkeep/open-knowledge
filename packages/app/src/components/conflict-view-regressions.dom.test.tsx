// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

let currentT: typeof renderLinguiTemplate = renderLinguiTemplate;

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: currentT }),
}));

const { ConflictView } = await import('./ConflictView');

afterEach(() => {
  currentT = renderLinguiTemplate;
  cleanup();
});

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(props: {
  ours: string;
  base: string;
  theirs: string;
  onResolve?: (content: string) => void | Promise<void>;
}) {
  const onResolve = props.onResolve ?? vi.fn();
  render(
    <ConflictView
      fileName="notes/plan.md"
      ours={props.ours}
      base={props.base}
      theirs={props.theirs}
      onResolve={onResolve}
    />,
  );
  await settle();
  return onResolve;
}

test('a conflict the three-way merge resolves cleanly still offers Apply', async () => {
  await mount({
    base: 'alpha\nbeta\ngamma\n',
    ours: 'alpha\nThe rollout plan is ready.\nbeta\ngamma\n',
    theirs: 'alpha\nbeta\nThe rollout plan is ready.\ngamma\n',
  });

  expect(screen.queryByRole('button', { name: /^Accept current/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Apply changes' })).toBeTruthy();
});

test('a file with no trailing newline does not gain one', async () => {
  // Byte-exact round-tripping is the write-path contract (precedent #57).
  const onResolve = vi.fn();
  await mount({
    base: 'intro\n\nBASE',
    ours: 'intro\n\nOURS',
    theirs: 'intro\n\nTHEIRS',
    onResolve,
  });

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();
  screen.getByRole('button', { name: 'Apply changes' }).click();
  await settle();

  expect(onResolve).toHaveBeenCalledTimes(1);
  expect(onResolve.mock.calls[0][0]).toBe('intro\n\nOURS');
});

test('Show original stays shut while a redo stack is standing', async () => {
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
  });

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();
  screen.getByRole('button', { name: 'Undo' }).click();
  await settle();

  const redo = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
  expect(redo.disabled).toBe(false);
  const toggle = screen.getByRole('button', { name: 'Show original' }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
});

test('Apply commits once however many times it is clicked', async () => {
  const onResolve = vi.fn();
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
    onResolve,
  });

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();

  const apply = screen.getByRole('button', { name: 'Apply changes' });
  apply.click();
  apply.click();
  apply.click();
  await settle();

  expect(onResolve).toHaveBeenCalledTimes(1);
});

test('the Apply latch is held until the resolve settles, not until the next tick', async () => {
  let release!: () => void;
  const inFlight = new Promise<void>((r) => {
    release = r;
  });
  const onResolve = vi.fn(() => inFlight);

  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
    onResolve,
  });
  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();

  const apply = screen.getByRole('button', { name: 'Apply changes' });
  apply.click();
  await settle();
  apply.click();
  await settle();
  expect(onResolve).toHaveBeenCalledTimes(1);

  release();
  await settle();
});

test('a marker-lookalike line in the content withholds every control', async () => {
  const onResolve = vi.fn();
  await mount({
    base: 'intro\n\ntail\n',
    ours: 'intro\n\nOurs Section\n\nours body\n\ntail\n',
    theirs: 'intro\n\nNew Section\n=======\n\ntheirs body\n\ntail\n',
    onResolve,
  });

  expect(screen.queryByRole('button', { name: /^Accept current/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Accept incoming/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  expect(screen.getByText(/look like conflict markers/)).toBeTruthy();
  expect(onResolve).not.toHaveBeenCalled();
});

test('an ordinary conflict is unaffected by the parse check', async () => {
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
  });

  expect(screen.queryByText(/look like conflict markers/)).toBeNull();
  expect(screen.getByRole('button', { name: /^Accept current/ })).toBeTruthy();
});

test('resolving one conflict does not make the others look misparsed', async () => {
  await mount({
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOURS ONE\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nTHEIRS ONE\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
  });

  expect(screen.getAllByRole('button', { name: /^Accept current/ })).toHaveLength(2);

  screen.getAllByRole('button', { name: /^Accept current/ })[0].click();
  await settle();

  expect(screen.queryByText(/look like conflict markers/)).toBeNull();
  expect(screen.getAllByRole('button', { name: /^Accept current/ })).toHaveLength(1);
});

test('both explanatory strips announce themselves to screen readers', async () => {
  await mount({
    base: 'intro\n\ntail\n',
    ours: 'intro\n\nOurs Section\n\nours body\n\ntail\n',
    theirs: 'intro\n\nNew Section\n=======\n\ntheirs body\n\ntail\n',
  });
  expect(screen.getByRole('status')).toHaveProperty(
    'textContent',
    expect.stringContaining('look like conflict markers') as unknown as string,
  );

  cleanup();

  await mount({ base: 'intro\n', ours: '', theirs: 'intro\n\nTHEIRS\n' });
  const banners = screen.getAllByRole('status');
  expect(banners.length).toBeGreaterThan(0);
  expect(banners.some((b) => /deleted on the current branch/.test(b.textContent ?? ''))).toBe(true);
});

test('each conflict has distinguishable control names', async () => {
  await mount({
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOURS ONE\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nTHEIRS ONE\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
  });

  expect(
    screen.getByRole('button', { name: 'Accept current version for conflict 1' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Accept current version for conflict 2' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Accept incoming version for conflict 2' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Accept both versions for conflict 1' })).toBeTruthy();
});

test('resolving, undoing and redoing are announced', async () => {
  await mount({
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOURS ONE\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nTHEIRS ONE\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
  });
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

  expect(live()).toBe('');

  screen.getAllByRole('button', { name: /^Accept current/ })[0].click();
  await settle();
  expect(live()).toBe('Conflicts remaining: 1.');

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();
  expect(live()).toBe('All conflicts resolved. Apply changes to save.');

  screen.getByRole('button', { name: 'Undo' }).click();
  await settle();
  expect(live()).toBe('Conflicts remaining: 1.');
});

test('a refusal never renders alongside live controls', async () => {
  await mount({
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOurs One\n\nours body\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nNew Section\n=======\n\ntheirs body\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
  });

  expect(screen.getByText(/look like conflict markers/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Accept current/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Accept incoming/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Accept both/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
});

test('sides disagreeing on the EOF newline yield exactly one, not two', async () => {
  const onResolve = vi.fn();
  await mount({
    base: 'intro\n\nBASE',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS',
    onResolve,
  });

  screen.getByRole('button', { name: /^Accept incoming/ }).click();
  await settle();
  screen.getByRole('button', { name: 'Apply changes' }).click();
  await settle();

  expect(onResolve.mock.calls[0][0]).toBe('intro\n\nTHEIRS\n');
});

test('accepting the side that has a trailing newline keeps exactly one', async () => {
  const onResolve = vi.fn();
  await mount({
    base: 'intro\n\nBASE',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS',
    onResolve,
  });

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();
  screen.getByRole('button', { name: 'Apply changes' }).click();
  await settle();

  expect(onResolve.mock.calls[0][0]).toBe('intro\n\nOURS\n');
});

test('a language change does not discard accepted resolutions', async () => {
  const onResolve = vi.fn();
  const props = {
    fileName: 'notes/plan.md',
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOURS ONE\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nTHEIRS ONE\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
    onResolve,
  };
  const view = render(<ConflictView {...props} />);
  await settle();

  screen.getAllByRole('button', { name: /^Accept current/ })[0].click();
  await settle();
  expect(screen.getAllByRole('button', { name: /^Accept current/ })).toHaveLength(1);

  currentT = ((...args: Parameters<typeof renderLinguiTemplate>) =>
    renderLinguiTemplate(...args)) as typeof renderLinguiTemplate;
  view.rerender(<ConflictView {...props} />);
  await settle();

  expect(screen.getAllByRole('button', { name: /^Accept current/ })).toHaveLength(1);
});

test('the diff region is a named, keyboard-reachable landmark', async () => {
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
  });
  const region = screen.getByRole('region', { name: /Conflict diff for/ });
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(region.tagName).toBe('SECTION');
});
