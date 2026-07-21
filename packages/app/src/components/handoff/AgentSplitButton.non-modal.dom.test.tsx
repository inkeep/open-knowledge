/**
 * The composer agent picker can hand directly to the modal agent catalog.
 * Keeping the picker non-modal prevents Radix's dropdown pointer lock from
 * surviving that surface transition and making the app appear frozen.
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

describe('AgentSplitButton non-modal contract', () => {
  afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = '';
  });

  test('opening the composer picker leaves the rest of the app interactive', async () => {
    const user = userEvent.setup();
    render(
      <AgentSplitButton
        primary="Ask Claude"
        onPrimary={() => {}}
        installedTargets={[]}
        selectedTargetId={null}
        onSelectTarget={() => {}}
        thread={{ selected: true, onSelect: () => {} }}
        threadAgents={[
          {
            key: 'registry:claude-acp',
            id: 'claude-acp',
            name: 'Claude',
            selected: true,
            onSelect: () => {},
          },
        ]}
        onBrowseThreadAgents={() => {}}
        triggerAriaLabel="Choose agent"
        testIds={{
          primary: 'primary',
          trigger: 'trigger',
          menu: 'menu',
          option: (id) => `option-${id}`,
          terminal: 'terminal',
          threadBrowse: 'browse',
        }}
      />,
    );

    await user.click(screen.getByTestId('trigger'));
    expect(screen.getByTestId('menu')).toBeDefined();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
