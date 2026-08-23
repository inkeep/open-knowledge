/**
 * The dock never pins its own height to whatever it happened to measure.
 *
 * It used to: an effect measured the content the first time the dock opened and
 * adopted the number as `style.height`. That measurement always ran before
 * `/api/skills` resolved, so it read an empty box — 16px of group padding — and
 * froze the panel there for the session. Every skill then rendered inside a
 * 16px strip, which is indistinguishable from having no skills, and is how it
 * was reported.
 *
 * jsdom is why the existing suite could not see it: `getBoundingClientRect()`
 * returns 0 for everything, and the adoption was guarded on `measured > 0`, so
 * the branch never ran under test while running for every real user. These
 * tests stub the rect — a real layout is the only condition the bug needs.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

// Stands in for the real section, which fetches on expand. Growing this list is
// what makes the content taller AFTER the open commit, reproducing the load the
// measurement used to race.
let sectionRows: string[] = [];
vi.mock('@/components/SkillsSidebarSection', () => ({
  SkillsSidebarSection: ({ dockExpanded }: { dockExpanded: boolean }) => (
    <div data-testid="skills-section">
      {dockExpanded ? sectionRows.map((name) => <div key={name}>{name}</div>) : null}
    </div>
  ),
}));
vi.mock('@/hooks/use-create-blank-skill', () => ({
  useCreateBlankSkill: () => ({ createBlank: vi.fn() }),
}));
vi.mock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => vi.fn() }));

const { SkillsSidebarDock } = await import('./SkillsSidebarDock');
const { __resetSkillsDockExpandedForTests, readSkillsDockHeight } = await import(
  './skills-dock-expanded-store'
);

/** Every element measures as `EMPTY_BOX` until the test says otherwise — the
 *  group padding a never-populated dock reports in a real browser. */
const EMPTY_BOX = 16;
let boxHeight = EMPTY_BOX;
let originalRect: typeof Element.prototype.getBoundingClientRect;
let originalObserver: typeof globalThis.ResizeObserver;
/** Callbacks of every live observer, so a test can fire them the way a real
 *  layout change would. */
let observerCallbacks: ResizeObserverCallback[] = [];

beforeEach(() => {
  boxHeight = EMPTY_BOX;
  sectionRows = [];
  observerCallbacks = [];
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function stubbed(this: Element) {
    return { ...new DOMRect(0, 0, 200, boxHeight), height: boxHeight } as DOMRect;
  };
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      observerCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  globalThis.ResizeObserver = originalObserver;
  __resetSkillsDockExpandedForTests();
});

function renderDock(props: { filesOpen?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <SkillsSidebarDock {...props} />
    </TooltipProvider>,
  );
}

/** Open the dock, whatever it was. The header is a TOGGLE, so a bare click is
 *  order-dependent: the expanded flag is stored, and a test that inherits it
 *  would close the dock instead of opening it. */
function expand() {
  const dock = screen.getByTestId('skills-dock');
  if (dock.getAttribute('data-state') !== 'open') {
    fireEvent.click(screen.getByText('Skills Studio'));
  }
}

function content(): HTMLElement {
  const el = screen
    .getByTestId('skills-dock')
    .querySelector<HTMLElement>('[data-slot="collapsible-content"]');
  if (el === null) throw new Error('collapsible content not mounted');
  return el;
}

test('expanding onto an empty list does not freeze the dock at the empty height', () => {
  renderDock();
  expand();

  // The whole bug in one assertion: an inline pixel height here is the panel
  // committing to the size it had before its content existed.
  expect(content().style.height).toBe('');
  // The cap is still what sizes it, exactly as the never-dragged contract says.
  expect(content().style.maxHeight).toBe('45vh');
});

test('the dock still shows its rows when the list lands after the open', () => {
  const { rerender } = renderDock();
  expand();

  // The list resolves and the section fills — the sequence the measurement used
  // to lose to.
  sectionRows = Array.from({ length: 134 }, (_, i) => `skill ${i}`);
  boxHeight = 2400;
  rerender(
    <TooltipProvider>
      <SkillsSidebarDock />
    </TooltipProvider>,
  );

  screen.getByText('skill 133');
  expect(content().style.height).toBe('');
  expect(content().style.maxHeight).toBe('45vh');
});

test('nothing is persisted by merely opening the dock', () => {
  // Adoption was local state, but a stored height would have been worse: it
  // would outlive the reload that is the only way a user escaped this.
  renderDock();
  expand();
  expect(readSkillsDockHeight()).toBe(null);
});

test('the resize handle reports the panel it is actually attached to', () => {
  // The adoption existed to give `aria-valuenow` a number. It still gets one,
  // from an observer — so the number tracks the panel instead of freezing it.
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');
  // Before any observation, the floor stands in rather than a wrong number.
  expect(handle.getAttribute('aria-valuenow')).toBe('96');

  act(() => {
    boxHeight = 320;
    for (const cb of observerCallbacks) cb([], {} as ResizeObserver);
  });
  expect(handle.getAttribute('aria-valuenow')).toBe('320');
  // Reporting a size is not the same as taking one.
  expect(content().style.height).toBe('');
});

test('a dragged height is honoured, and is the only thing that sets one', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  // Arrow keys are the drag's keyboard equivalent and go through the same clamp.
  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
  });

  // 16 (measured) + 32 (step) is below the 96 floor, so the clamp is what makes
  // this a usable panel rather than a slightly taller sliver.
  expect(content().style.height).toBe('96px');
  expect(readSkillsDockHeight()).toBe(96);
});

test('with Files collapsed the dock fills the sidebar instead of capping at 45vh', () => {
  // The other half of "truncated instead of filling the available sidebar
  // height": nothing above is claiming the slack any more, so stopping at the
  // cap leaves the dock clipped mid-row with a blank half-sidebar under it.
  renderDock({ filesOpen: false });
  expand();

  expect(content().style.maxHeight).toBe('');
  expect(content().className).toContain('flex-1');
  // Still no committed pixel height — filling is not the user stating a size.
  expect(content().style.height).toBe('');
});

test('with Files collapsed there is no resize handle — nothing to size against', () => {
  // The dock fills, so a live handle would persist heights that cannot bind
  // and report an ARIA value nothing uses. The header trigger still collapses.
  renderDock({ filesOpen: false });
  expand();

  expect(screen.queryByTestId('skills-dock-resize')).toBeNull();
});

test('with Files open the cap still protects the file tree body', () => {
  renderDock({ filesOpen: true });
  expand();

  expect(content().style.maxHeight).toBe('45vh');
  expect(content().className).not.toContain('flex-1');
});

test('a dragged height binds while Files is open; with Files collapsed the dock fills', () => {
  // A size dragged against the Files tree is a claim against THAT contest.
  // With Files collapsed nothing else wants the room, and honoring the height
  // rendered a clipped tree above a dead black band — read as broken, not as
  // a chosen size.
  renderDock({ filesOpen: true });
  expand();
  act(() => {
    fireEvent.keyDown(screen.getByTestId('skills-dock-resize'), { key: 'ArrowUp' });
  });
  expect(content().style.height).toBe('96px');

  cleanup();
  renderDock({ filesOpen: false });
  expand();
  expect(content().style.height).toBe('');
  expect(content().className).toContain('flex-1');
});

test('only an EXPANDED dock claims the slack', () => {
  // Collapsed it is one header row; growing it would push the row off the
  // bottom of an otherwise empty sidebar.
  renderDock({ filesOpen: false });
  const dock = screen.getByTestId('skills-dock');
  expect(dock.className).toContain('shrink-0');

  expand();
  expect(screen.getByTestId('skills-dock').className).toContain('flex-1');
});
test('shrinking a dock already at its minimum collapses it instead of doing nothing', async () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  // Measured 16px is at-or-below the 96 floor, so ArrowDown has nothing left
  // to shrink — before drag-to-collapse this keypress was a silent no-op,
  // which read as "no way to collapse it all the way".
  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
  });

  expect(screen.getByTestId('skills-dock').getAttribute('data-state')).toBe('closed');
  // The collapsing gesture is not a size choice — nothing is persisted.
  expect(readSkillsDockHeight()).toBeNull();
  // The handle unmounted with the dock — focus hands off to the header
  // trigger instead of falling to <body>, so a keyboard user can reopen.
  // (The handoff rides a rAF, so poll rather than tick fake timers.)
  await waitFor(() => {
    expect(document.activeElement?.textContent).toContain('Skills Studio');
  });
});

test('ArrowDown above the minimum shrinks by one step without collapsing', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  // Measure the dock ABOVE the floor, so there is room to shrink.
  boxHeight = 160;

  // The normal shrink path: one step down, still open. A flipped sign in the
  // ArrowUp/ArrowDown ternary would grow here instead.
  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
  });
  expect(readSkillsDockHeight()).toBe(128);
  expect(screen.getByTestId('skills-dock').getAttribute('data-state')).toBe('open');
});

test('a drag released well below the minimum collapses the dock, keeping the prior size', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  // First a real resize, so there is a chosen size to preserve.
  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
  });
  expect(readSkillsDockHeight()).toBe(96);

  // Then drag DOWN far past the floor (raw request 16 - 200 < 96 - 40) and
  // release: the clamp held the visible height at the floor throughout, but
  // the release reads the unclamped request and collapses.
  act(() => {
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 300 });
    fireEvent.pointerUp(window, { clientY: 300 });
  });

  expect(screen.getByTestId('skills-dock').getAttribute('data-state')).toBe('closed');
  // The chosen size survives the collapsing gesture.
  expect(readSkillsDockHeight()).toBe(96);
});
