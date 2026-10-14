import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { NothingOpen } from '@/components/NothingOpen';
import { ConfigContext } from '@/lib/config-context';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibility,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import {
  configContextWithTerminal,
  type ProjectTerminalSetting,
  TERMINAL_SETTING_UNSET,
} from '@/test-utils/config-context';

const HIDDEN: PaneVisibility = { open: false, onScreen: false };
const TERMINAL_OFF: ProjectTerminalSetting = { synced: true, enabled: false };

function renderNothingOpen(setting: ProjectTerminalSetting = TERMINAL_SETTING_UNSET) {
  return render(
    <ConfigContext value={configContextWithTerminal(setting)}>
      <NothingOpen />
    </ConfigContext>,
  );
}

function openButtonNames(): string[] {
  return screen.getAllByRole('button').map((button) => button.textContent ?? '');
}

afterEach(() => {
  cleanup();
  __resetPaneVisibilityStoreForTests();
});

describe('Nothing open', () => {
  test('names itself with no hint line and offers every pane the header offers', () => {
    paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: HIDDEN });
    renderNothingOpen();

    expect(screen.getByRole('region', { name: 'Nothing open' })).toBeTruthy();
    expect(screen.queryByText(/Turn panels on/)).toBeNull();
    expect(openButtonNames()).toEqual(['Open editor', 'Open agents', 'Open terminal']);
  });

  test('offers no terminal where no terminal can exist', () => {
    paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    renderNothingOpen();

    expect(openButtonNames()).toEqual(['Open editor', 'Open agents']);
  });

  test('offers no terminal while the project has it turned off', () => {
    paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: HIDDEN });
    renderNothingOpen(TERMINAL_OFF);

    expect(openButtonNames()).toEqual(['Open editor', 'Open agents']);
  });

  test('each button asks for its pane to be shown', async () => {
    const user = userEvent.setup();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));
    paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: HIDDEN });
    renderNothingOpen();

    await user.click(screen.getByRole('button', { name: 'Open editor' }));
    await user.click(screen.getByRole('button', { name: 'Open agents' }));
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    expect(requests).toEqual([
      { pane: 'editor', open: true },
      { pane: 'agents', open: true },
      { pane: 'terminal', open: true },
    ]);
  });

  test('shows no Ask AI box and can take focus itself', () => {
    paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    renderNothingOpen();
    const region = screen.getByRole('region', { name: 'Nothing open' });

    act(() => region.focus());

    expect(document.activeElement).toBe(region);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
