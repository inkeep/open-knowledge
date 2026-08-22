/**
 * The composer agent picker's "Configure agents" row hands directly to the modal
 * Settings dialog. Keeping the picker non-modal prevents Radix's dropdown
 * pointer lock from surviving that surface transition and making the app appear
 * frozen.
 *
 * This suite also pins `AgentSplitButton`'s In app group accessible name against
 * a real Radix `DropdownMenuGroup`. The suites that reach it through
 * `BottomComposer` (`BottomComposer.dom.test.tsx`, `composer-shared-draft`)
 * double `DropdownMenuGroup` as a bare fragment that discards `aria-label`, and
 * the suites that would reach it through `CommentSendFooter` stub that
 * component out.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentSplitButton } from './AgentSplitButton';

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

// No `terminal`/`terminals` and an empty `enabledTargets`, so the menu this mounts is
// In app -> Configure agents. Both tests below are scoped to that: nothing here
// exercises the Terminal or External apps sections.
function renderSplitButton() {
  render(
    <AgentSplitButton
      primary="Ask Claude"
      onPrimary={() => {}}
      enabledTargets={[]}
      selectedTargetId={null}
      onSelectTarget={() => {}}
      threadAgents={[
        {
          key: 'registry:claude-acp',
          id: 'claude-acp',
          name: 'Claude',
          selected: true,
          onSelect: () => {},
        },
      ]}
      onOpenSettings={() => {}}
      triggerAriaLabel="Choose agent"
      testIds={{
        primary: 'primary',
        trigger: 'trigger',
        menu: 'menu',
        option: (id) => `option-${id}`,
        terminal: 'terminal',
      }}
    />,
  );
}

describe('AgentSplitButton non-modal contract', () => {
  afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = '';
  });

  test('opening the composer picker leaves the rest of the app interactive', async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu')).toBeDefined();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  // Resolves through the accessibility tree against a real Radix
  // `DropdownMenuGroup` — `getByRole` computes both the role and the accessible
  // name. On a Radix group that name comes from `aria-label` while the visible
  // heading is a separate label node, so both are worth pinning, along with the
  // absence of the maturity badge this group used to carry.
  test('names the In app group "In app" and carries no maturity badge', async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.click(screen.getByTestId('trigger'));

    const inApp = screen.getByRole('group', { name: 'In app' });
    expect(inApp.textContent).toContain('In app');
    expect(inApp.textContent).not.toContain('Beta');
  });
});
