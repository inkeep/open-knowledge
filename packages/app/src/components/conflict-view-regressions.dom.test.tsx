// @vitest-environment jsdom
/**
 * Regressions found by a cold review of the Pierre conflict view.
 *
 * Each test here corresponds to a way the view could strand or shortchange a
 * user that the happy-path suite did not reach: a conflict with nothing to
 * accept, a file whose last line has no newline, a redo stack thrown away by a
 * display toggle, and an Apply that commits more than once.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

// `t`'s IDENTITY is the thing under test in the locale-change case: Lingui
// swaps the context object on every activate(), so a stable mock would make
// that test pass no matter what the effect's deps say.
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
  // The server records a conflict whenever its merge declines, and it declines
  // on grounds the client's line-level re-merge does not reproduce — the two
  // insertions below land in different places and merge without overlapping.
  // With no divergent region there is no Accept control to press, so if Apply
  // waits on one being pressed the file can never be resolved from the UI.
  await mount({
    base: 'alpha\nbeta\ngamma\n',
    ours: 'alpha\nThe rollout plan is ready.\nbeta\ngamma\n',
    theirs: 'alpha\nbeta\nThe rollout plan is ready.\ngamma\n',
  });

  expect(screen.queryByRole('button', { name: /^Accept current/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Apply changes' })).toBeTruthy();
});

test('a file with no trailing newline does not gain one', async () => {
  // Pierre rebuilds the file from its parsed rows and terminates the last one.
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
  // Toggling re-synthesises the marker text and renumbers every conflict, so
  // it discards in-progress work. Undoing back to the start clears canUndo but
  // leaves a full redo stack — which is work too.
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
  // Server-side this runs `git add` + `git commit --no-edit`; the second and
  // third calls find no tracked conflict and surface an error toast after a
  // resolution that in fact succeeded.
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
  // The previous test passes with a synchronous onResolve whether or not the
  // latch awaits anything. Server-side Apply runs `git add` + a commit, so the
  // window that matters is the whole in-flight request: a latch released on the
  // next microtask still lets a second click race the first.
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
  // Still in flight — a click here is the double-commit the latch exists for.
  apply.click();
  await settle();
  expect(onResolve).toHaveBeenCalledTimes(1);

  release();
  await settle();
});

test('a marker-lookalike line in the content withholds every control', async () => {
  // Seven-or-more `=` is Pierre's separator pattern and also an ordinary line a
  // user may have typed. Inside a conflict section the text then carries two
  // lines that look identical, Pierre anchors the split on the wrong one, and
  // resolving drops the user's own lines while reporting success. Refuse
  // instead: the parse disagrees with the markers we wrote.
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
  // The check compares integers both sides should agree on, so it must never
  // fire on a file whose markers parse correctly.
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
  });

  expect(screen.queryByText(/look like conflict markers/)).toBeNull();
  expect(screen.getByRole('button', { name: /^Accept current/ })).toBeTruthy();
});

test('resolving one conflict does not make the others look misparsed', async () => {
  // The parse check compares against the indices we synthesised, which describe
  // the ORIGINAL text. Every render after a resolution is of Pierre's own
  // output, where the surviving conflicts have shifted — so the check has to
  // stop after the first parse or a second conflict would be refused the moment
  // the first one is accepted.
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
  // The boundary swaps this view in without a navigation, so a reader meeting
  // the pane in document order finds an empty diff and no reason for it. These
  // strips exist precisely because there is nothing to render.
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
  // Browsing by button in a multi-conflict file, the visible labels repeat
  // verbatim — so without a per-conflict name a screen-reader user gets
  // "Accept current" twice with no way to tell which region each acts on.
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
  // Every action here mutates the diff imperatively and moves focus to the
  // scroll container, so without a live region a screen-reader user gets no
  // signal that the click landed — including when Apply changes appears.
  await mount({
    base: 'intro\n\nBASE ONE\n\nmiddle\n\nBASE TWO\n\ntail\n',
    ours: 'intro\n\nOURS ONE\n\nmiddle\n\nOURS TWO\n\ntail\n',
    theirs: 'intro\n\nTHEIRS ONE\n\nmiddle\n\nTHEIRS TWO\n\ntail\n',
  });
  const live = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

  // Pre-registered and empty: a region inserted with its text is not announced.
  expect(live()).toBe('');

  screen.getAllByRole('button', { name: /^Accept current/ })[0].click();
  await settle();
  expect(live()).toBe('Conflicts remaining: 1.');

  screen.getByRole('button', { name: /^Accept current/ }).click();
  await settle();
  expect(live()).toBe('All conflicts resolved. Apply changes to save.');

  // Undo must not keep claiming the file is resolved.
  screen.getByRole('button', { name: 'Undo' }).click();
  await settle();
  expect(live()).toBe('Conflicts remaining: 1.');
});

test('a refusal never renders alongside live controls', async () => {
  // Pierre reports regions one at a time. Clearing `controls` on the region
  // that disagrees still let every LATER region append to the emptied array,
  // so a two-conflict file showed the banner beside a working Accept button.
  // The lookalike sits in the FIRST conflict; the second parses cleanly.
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
  // The synthesis now keeps the EOF decision out of the conflict: each side is
  // merged without its trailing empty line, and one is re-appended when any
  // input had it. Previously the divergence reached EOF, the '' landed inside
  // the conflict region, and Pierre's row terminator added a second — the file
  // gained a newline no side had, in bytes written to disk and committed.
  //
  // The residual is a normalisation, not a drift: once EOF sits outside the
  // conflict it is a property of the file rather than of the winning region,
  // and a file some side terminated ends terminated. The both-sides-agree case
  // still round-trips exactly, via `matchTrailingNewline`.
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
  // `t` from useLingui is bound to the Lingui context object, swapped on every
  // `i18n.activate()` — a preference change, an external .ok/config.yml edit,
  // another window. Held in the mount effect's dep array it rebuilt the whole
  // instance: new history, cleanUp, every state reset. Accepting a conflict and
  // then changing language silently threw the resolution away.
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

  // A fresh `t` identity, which is exactly what i18n.activate() produces.
  currentT = ((...args: Parameters<typeof renderLinguiTemplate>) =>
    renderLinguiTemplate(...args)) as typeof renderLinguiTemplate;
  view.rerender(<ConflictView {...props} />);
  await settle();

  // Still one remaining: the accepted region stayed accepted.
  expect(screen.getAllByRole('button', { name: /^Accept current/ })).toHaveLength(1);
});

test('the diff region is a named, keyboard-reachable landmark', async () => {
  // axe cannot see this: the suite's own scan notes that
  // scrollable-region-focusable does not evaluate under jsdom, which reports
  // no layout. Asserting the attributes directly is the repo's existing
  // workaround for exactly that gap.
  await mount({
    base: 'intro\n\nBASE\n',
    ours: 'intro\n\nOURS\n',
    theirs: 'intro\n\nTHEIRS\n',
  });
  const region = screen.getByRole('region', { name: /Conflict diff for/ });
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(region.tagName).toBe('SECTION');
});
