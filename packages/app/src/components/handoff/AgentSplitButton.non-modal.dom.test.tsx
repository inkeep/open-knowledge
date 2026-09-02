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

  test('names the In app group "In app" and carries no maturity badge', async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.click(screen.getByTestId('trigger'));

    const inApp = screen.getByRole('group', { name: 'In app' });
    expect(inApp.textContent).toContain('In app');
    expect(inApp.textContent).not.toContain('Beta');
  });
});
