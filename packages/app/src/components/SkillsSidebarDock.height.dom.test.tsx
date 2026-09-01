import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

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

const EMPTY_BOX = 16;
let boxHeight = EMPTY_BOX;
let originalRect: typeof Element.prototype.getBoundingClientRect;
let originalObserver: typeof globalThis.ResizeObserver;
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

  expect(content().style.height).toBe('');
  expect(content().style.maxHeight).toBe('45vh');
});

test('the dock still shows its rows when the list lands after the open', () => {
  const { rerender } = renderDock();
  expand();

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
  renderDock();
  expand();
  expect(readSkillsDockHeight()).toBe(null);
});

test('the resize handle reports the panel it is actually attached to', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');
  expect(handle.getAttribute('aria-valuenow')).toBe('96');

  act(() => {
    boxHeight = 320;
    for (const cb of observerCallbacks) cb([], {} as ResizeObserver);
  });
  expect(handle.getAttribute('aria-valuenow')).toBe('320');
  expect(content().style.height).toBe('');
});

test('a dragged height is honoured, and is the only thing that sets one', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
  });

  expect(content().style.height).toBe('96px');
  expect(readSkillsDockHeight()).toBe(96);
});

test('with Files collapsed the dock fills the sidebar instead of capping at 45vh', () => {
  renderDock({ filesOpen: false });
  expand();

  expect(content().style.maxHeight).toBe('');
  expect(content().className).toContain('flex-1');
  expect(content().style.height).toBe('');
});

test('with Files collapsed there is no resize handle — nothing to size against', () => {
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

  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
  });

  expect(screen.getByTestId('skills-dock').getAttribute('data-state')).toBe('closed');
  expect(readSkillsDockHeight()).toBeNull();
  await waitFor(() => {
    expect(document.activeElement?.textContent).toContain('Skills Studio');
  });
});

test('ArrowDown above the minimum shrinks by one step without collapsing', () => {
  renderDock();
  expand();
  const handle = screen.getByTestId('skills-dock-resize');

  boxHeight = 160;

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

  act(() => {
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
  });
  expect(readSkillsDockHeight()).toBe(96);

  act(() => {
    fireEvent.pointerDown(handle, { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 300 });
    fireEvent.pointerUp(window, { clientY: 300 });
  });

  expect(screen.getByTestId('skills-dock').getAttribute('data-state')).toBe('closed');
  expect(readSkillsDockHeight()).toBe(96);
});
