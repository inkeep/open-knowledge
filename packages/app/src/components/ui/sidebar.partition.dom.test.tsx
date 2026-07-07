/**
 * RTL behavioral tests for SidebarProvider's responsive partition
 * model + Per-Partition Pins store + auto-collapse focus safety.
 *
 * The companion `sidebar.test.ts` is a raw-source structural guard
 * (single-render-path, no-mobile-translate, no-sidebar_state-cookie). This
 * file mounts the provider against jsdom + RTL and asserts the runtime
 * contract those source guards can't reach:
 *
 *   1. Synchronous first-paint state from (embedded host UA × innerWidth × pin).
 *   2. matchMedia('(min-width: 1024px)') change re-resolves the partition + state.
 *   3. Auto-collapse moves focus from inside the sidebar to the toggle.
 *   4. Trigger click writes the slot for the current partition WITHOUT clearing
 *      the slot for any other partition (partition-isolated memory).
 *
 * Substrate: jsdom (precedent #43); invocation via `bunx turbo run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readPins, SIDEBAR_PINS_KEY } from '@/lib/sidebar-pin-store';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar';

type Listener = (event: MediaQueryListEvent) => void;

type ControllableMql = MediaQueryList & {
  __setMatches: (next: boolean) => void;
};

let originalInnerWidth: number;
let originalMatchMedia: typeof window.matchMedia;
let originalUserAgent: string;

function installMatchMedia(initialMatches: boolean): ControllableMql {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    media: '(min-width: 1024px)',
    onchange: null,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'change' && typeof listener === 'function') {
        listeners.add(listener as Listener);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'change' && typeof listener === 'function') {
        listeners.delete(listener as Listener);
      }
    },
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    __setMatches(next: boolean) {
      this.matches = next;
      for (const l of listeners) {
        l({ matches: next, media: this.media } as MediaQueryListEvent);
      }
    },
  } as ControllableMql;
  window.matchMedia = ((_query: string) => mql) as typeof window.matchMedia;
  return mql;
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua });
}

function getSidebarState(): 'expanded' | 'collapsed' | null {
  const el = document.querySelector('[data-slot="sidebar"]');
  const v = el?.getAttribute('data-state');
  return v === 'expanded' || v === 'collapsed' ? v : null;
}

function Fixture() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton data-testid="content-item">Notes</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

beforeEach(() => {
  originalInnerWidth = window.innerWidth;
  originalMatchMedia = window.matchMedia;
  originalUserAgent = window.navigator.userAgent;
  // jsdom-preload exposes window.localStorage but does not also install the
  // bare globalThis.localStorage that production source paths use directly.
  // Install it for the duration of the test so the SidebarProvider's
  // readPins()/applyToggle() (no-arg storage default) exercise the real
  // jsdom storage instead of falling through readPins's try/catch.
  (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  setInnerWidth(originalInnerWidth);
  window.matchMedia = originalMatchMedia;
  setUserAgent(originalUserAgent);
  window.localStorage.clear();
});

describe('SidebarProvider — partition × pin resolution at mount (FR-1, FR-3, FR-4, FR-6)', () => {
  test('non-embedded, ≥1024px, no pin → expanded (smart default)', () => {
    setInnerWidth(1280);
    installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');
  });

  test('non-embedded, <1024px, no pin → collapsed (smart default — kills the clip bug)', () => {
    setInnerWidth(900);
    installMatchMedia(false);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
  });

  test('embedded host UA → collapsed regardless of width (Cursor)', () => {
    setUserAgent('Mozilla/5.0 Cursor(Beta)/1.5.0 (KHTML, like Gecko) Chrome/130');
    setInnerWidth(1920);
    installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
  });

  test('embedded host UA → collapsed regardless of width (Codex(Dev) parenthetical-tolerant)', () => {
    setUserAgent('Mozilla/5.0 Codex(Dev)/26.513.31313 Chrome/130');
    setInnerWidth(1920);
    installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
  });

  test('above-partition slot overrides smart default (slot: collapsed at wide viewport)', () => {
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { above: 'collapsed' } }));
    setInnerWidth(1280);
    installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
  });

  test('below-partition slot overrides smart default (slot: open at narrow viewport)', () => {
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { below: 'open' } }));
    setInnerWidth(900);
    installMatchMedia(false);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');
  });

  test('absent slot for current partition falls back to smart default', () => {
    // Only the above slot is populated; mounting below-threshold consults the
    // below slot (absent) and falls back to smartDefault('below') = collapsed.
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { above: 'open' } }));
    setInnerWidth(900);
    installMatchMedia(false);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
  });

  test('corrupt localStorage falls back to smart default and does not throw', () => {
    window.localStorage.setItem(SIDEBAR_PINS_KEY, 'not json {');
    setInnerWidth(1280);
    installMatchMedia(true);
    expect(() => render(<Fixture />)).not.toThrow();
    expect(getSidebarState()).toBe('expanded');
  });
});

describe('SidebarProvider — matchMedia re-resolution (FR-3, FR-6)', () => {
  test('above → below: above slot does not apply to below; below smart default applies', () => {
    // Above-partition slot: open. Mount above-threshold → effective open.
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { above: 'open' } }));
    setInnerWidth(1280);
    const mql = installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');
    // Narrow the viewport across the threshold: below slot is absent.
    setInnerWidth(900);
    act(() => {
      mql.__setMatches(false);
    });
    // Below smart default applies (collapsed) — the above slot is independent.
    expect(getSidebarState()).toBe('collapsed');
  });

  test('below → above: smart default re-applies when no pin', () => {
    setInnerWidth(900);
    const mql = installMatchMedia(false);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');
    setInnerWidth(1280);
    act(() => {
      mql.__setMatches(true);
    });
    expect(getSidebarState()).toBe('expanded');
  });

  test('above → below with same-partition slot: slot for the NEW partition is respected', () => {
    // Below-partition slot: open. Mount above-threshold (above slot absent) → expanded smart default.
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { below: 'open' } }));
    setInnerWidth(1280);
    const mql = installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');
    // Narrow across threshold: below slot now matches current partition.
    setInnerWidth(900);
    act(() => {
      mql.__setMatches(false);
    });
    expect(getSidebarState()).toBe('expanded');
  });
});

describe('SidebarProvider — focus safety on auto-collapse (FR-9 left side)', () => {
  test('focus inside the sidebar is moved to the toggle when matchMedia auto-collapses', () => {
    setInnerWidth(1280);
    const mql = installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');

    const contentItem = screen.getByTestId('content-item') as HTMLElement;
    contentItem.focus();
    expect(document.activeElement).toBe(contentItem);

    setInnerWidth(900);
    act(() => {
      mql.__setMatches(false);
    });

    expect(getSidebarState()).toBe('collapsed');
    const trigger = document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    expect(document.activeElement).toBe(trigger);
  });

  test('focus outside the sidebar is NOT moved on auto-collapse', () => {
    setInnerWidth(1280);
    const mql = installMatchMedia(true);
    render(
      <>
        <Fixture />
        <button type="button" data-testid="outside">
          Outside
        </button>
      </>,
    );
    expect(getSidebarState()).toBe('expanded');

    const outside = screen.getByTestId('outside') as HTMLElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    setInnerWidth(900);
    act(() => {
      mql.__setMatches(false);
    });

    expect(getSidebarState()).toBe('collapsed');
    // Focus is preserved on the outside element; the auto-collapse must not steal it.
    expect(document.activeElement).toBe(outside);
  });
});

describe('SidebarProvider — trigger click writes the current-partition slot (FR-3, FR-5, D13)', () => {
  test('click in above partition writes a slot under the `above` key', () => {
    setInnerWidth(1280);
    installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');

    const trigger = document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    expect(trigger).not.toBeNull();
    act(() => {
      fireEvent.click(trigger as HTMLElement);
    });

    expect(getSidebarState()).toBe('collapsed');
    expect(readPins(window.localStorage)).toEqual({
      left: { above: 'collapsed' },
    });
  });

  test('click in below partition PRESERVES the existing above slot (D13 — slots are independent)', () => {
    // Pre-seed an above slot; mount below-threshold so it does not apply
    // (smart default `collapsed` wins at first paint — the above slot
    // is consulted only when the partition becomes 'above').
    window.localStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify({ left: { above: 'open' } }));
    setInnerWidth(900);
    installMatchMedia(false);
    render(<Fixture />);
    expect(getSidebarState()).toBe('collapsed');

    const trigger = document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    expect(trigger).not.toBeNull();
    act(() => {
      fireEvent.click(trigger as HTMLElement);
    });

    expect(getSidebarState()).toBe('expanded');
    // Per-Partition Pins: the explicit toggle writes the `below` slot
    // and the previously-existing `above` slot is preserved. Both coexist.
    expect(readPins(window.localStorage)).toEqual({
      left: { above: 'open', below: 'open' },
    });
  });

  test('matchMedia re-resolution followed by click writes the NEW partition slot (closure freshness)', () => {
    // Start above-threshold, then narrow across the boundary, then click.
    // The slot must record the NEW partition, not the partition at mount.
    setInnerWidth(1280);
    const mql = installMatchMedia(true);
    render(<Fixture />);
    expect(getSidebarState()).toBe('expanded');

    setInnerWidth(900);
    act(() => {
      mql.__setMatches(false);
    });
    // matchMedia re-resolved: still no pin, below smart default applies.
    expect(getSidebarState()).toBe('collapsed');

    const trigger = document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    act(() => {
      fireEvent.click(trigger as HTMLElement);
    });

    // Slot under `below` (the partition the click happened in), not stale `above`.
    expect(readPins(window.localStorage)).toEqual({
      left: { below: 'open' },
    });
  });
});
