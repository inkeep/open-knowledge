/**
 * Tier-3 RTL behavioral test for `OpenInAgentMenu` — the non-modal contract.
 *
 * Regression guard for the Open-with-AI toolbar menu trapping the user on the
 * macOS desktop host. The menu lives in the editor header's
 * `-webkit-app-region: drag` zone; when it was a modal Radix surface it set
 * `document.body.style.pointerEvents = 'none'` while open. In the drag region,
 * the outside-pointerdown dismissal a modal layer relies on does not reliably
 * reach Radix's document listener, so the only clickable elements were the menu
 * items — the menu could not be dismissed by clicking outside, and the rest of
 * the chrome (notably the bottom-left ProjectSwitcher) was frozen behind
 * `body { pointer-events: none }`.
 *
 * The surface is now a Radix `Popover` (it hosts an instruction prompt box, so
 * it can no longer be a dropdown menu — a text field cannot live inside one).
 * Popover is non-modal by default, so the trap cannot recur; this test pins
 * that contract.
 *
 * The macOS `-webkit-app-region` swallow itself is not reproducible in jsdom
 * (the existing source-guard test in `OpenInAgentMenu.test.ts` documents that).
 * But the load-bearing precondition — whether opening the menu disables outside
 * pointer events at all — is pure Radix behavior and IS observable here: a
 * modal surface sets `body { pointer-events: none }` on open; a non-modal one
 * leaves it untouched. Pin the non-modal contract so the trap cannot return.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { HandoffDispatchInput } from './useHandoffDispatch';

// Radix Popover mounts a Popper (react-use-size → ResizeObserver) and a focus
// scope (NodeFilter); neither ships in the shared jsdom-preload. Hoist the
// shims locally, matching the sibling ShareButton.dom.test.tsx pattern.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

// OpenInAgentMenu calls useInstalledAgents and useHandoffDispatch at render —
// mock both so the mount is provider-free. useHandoffDispatch is mocked
// directly rather than leaned on to resolve config transitively, matching the
// sibling dom tests (e.g. FileSidebar.menu-action.dom.test.tsx) and keeping the
// test meaningful if the dispatch hook's own imports ever change. Empty `states`
// means every target is pre-probe (installed == null) → no agent rows render,
// just the disabled "Checking for installed agents" hint, keeping the mount
// surface minimal — the modal/non-modal behavior is
// independent of the rows.
mock.module('./useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {}, refresh: () => {} }),
}));
mock.module('./useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({ dispatch: async () => {}, reinstallCoworkSkill: async () => {} }),
}));

const { OpenInAgentMenu } = await import('./OpenInAgentMenu');

const FILE_INPUT: HandoffDispatchInput = {
  docContext: null,
  projectDir: '/tmp/project',
  docPath: 'note.md',
};

describe('OpenInAgentMenu non-modal contract', () => {
  afterEach(() => {
    cleanup();
    // Defensive: ensure no leaked modal style bleeds into the next test even
    // if a future regression reintroduces the modal layer.
    document.body.style.pointerEvents = '';
  });

  test('opening the menu does not disable outside pointer events (body stays interactive)', async () => {
    render(<OpenInAgentMenu input={FILE_INPUT} open onOpenChange={() => {}} />);

    // Sanity: the menu actually opened (controlled open → content is portaled).
    await waitFor(() => {
      expect(screen.queryByTestId('open-in-agent-menu')).not.toBeNull();
    });

    // The trap: a modal Radix dropdown sets `body { pointer-events: none }`,
    // freezing the rest of the chrome (e.g. the ProjectSwitcher). A non-modal
    // menu must leave the body interactive.
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
