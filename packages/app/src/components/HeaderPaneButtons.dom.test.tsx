import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { HeaderPaneButtons, useHeaderPaneButtonSet } from '@/components/HeaderPaneButtons';
import { TooltipProvider } from '@/components/ui/tooltip';
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
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const HIDDEN: PaneVisibility = { open: false, onScreen: false };
const SHOWN: PaneVisibility = { open: true, onScreen: true };
const OPEN_OFF_SCREEN: PaneVisibility = { open: true, onScreen: false };

const PRESSED_LOOK = ['bg-primary/10', 'text-primary'];
const PRESSED_HOVER_LOOK = ['hover:bg-primary/15'];
const HIGH_CONTRAST_OUTLINE = [
  'forced-colors:outline-solid',
  'forced-colors:outline-2',
  'contrast-more:outline-solid',
  'contrast-more:outline-2',
];

const ORIGINAL_PLATFORM = globalThis.navigator.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

const SETTINGS_LOADING: ProjectTerminalSetting = { synced: false, enabled: null };
const TERMINAL_OFF: ProjectTerminalSetting = { synced: true, enabled: false };
const TERMINAL_ON: ProjectTerminalSetting = { synced: true, enabled: true };

function Providers({
  setting,
  children,
}: {
  setting: ProjectTerminalSetting;
  children: ReactNode;
}) {
  return (
    <ConfigContext value={configContextWithTerminal(setting)}>
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </ConfigContext>
  );
}

function renderButtons(setting: ProjectTerminalSetting = TERMINAL_SETTING_UNSET) {
  const view = render(
    <Providers setting={setting}>
      <HeaderPaneButtons />
    </Providers>,
  );
  return {
    ...view,
    setTerminalSetting(next: ProjectTerminalSetting) {
      view.rerender(
        <Providers setting={next}>
          <HeaderPaneButtons />
        </Providers>,
      );
    },
  };
}

function paneButtonNames(): (string | null)[] {
  return within(screen.getByRole('group', { name: 'Panels' }))
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));
}

function recordRequests(): PaneVisibilityRequest[] {
  const requests: PaneVisibilityRequest[] = [];
  paneVisibilityStore.subscribeRequests((request) => requests.push(request));
  return requests;
}

function PaneSetProbe() {
  return <output data-testid="pane-set">{useHeaderPaneButtonSet().join(',')}</output>;
}

describe('HeaderPaneButtons', () => {
  afterEach(() => {
    __resetPaneVisibilityStoreForTests();
    setPlatform(ORIGINAL_PLATFORM);
  });

  test('renders Agents then Terminal inside a group named Panels, after a divider', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
    renderButtons();

    const group = screen.getByRole('group', { name: 'Panels' });
    const names = within(group)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Agents', 'Terminal']);
    const divider = screen.getByTestId('header-pane-divider');
    expect(divider.getAttribute('data-orientation')).toBe('vertical');
    expect(divider.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.contains(group)).toBe(false);
  });

  test('each button is a 28px ghost icon button with a hidden glyph and a stable test id', () => {
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    renderButtons();

    const agents = screen.getByTestId('header-pane-button-agents');
    const terminal = screen.getByTestId('header-pane-button-terminal');
    for (const button of [agents, terminal]) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('data-variant')).toBe('ghost');
      expect(button.getAttribute('data-size')).toBe('icon-sm');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(agents.querySelector('svg')?.classList.contains('lucide-sparkles')).toBe(true);
    expect(terminal.querySelector('svg')?.classList.contains('lucide-square-terminal')).toBe(true);
  });

  test('pressed state follows whether each pane is on screen and flips when the store publishes', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(agents.getAttribute('aria-pressed')).toBe('false');
    expect(terminal.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    });

    expect(screen.getByRole('button', { name: 'Agents' })).toBe(agents);
    expect(agents.getAttribute('aria-pressed')).toBe('true');
    expect(terminal.getAttribute('aria-pressed')).toBe('false');
  });

  test('a pane that is open but collapsed to zero size reads off, and a click asks to show it', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({
      editor: null,
      agents: OPEN_OFF_SCREEN,
      terminal: OPEN_OFF_SCREEN,
    });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(agents.getAttribute('aria-pressed')).toBe('false');
    expect(terminal.getAttribute('aria-pressed')).toBe('false');
    expectVisualClassTokensAbsent(agents.className, PRESSED_LOOK);

    await user.click(agents);
    await user.click(terminal);

    expect(requests).toEqual([
      { pane: 'agents', open: true, reason: 'user' },
      { pane: 'terminal', open: true, reason: 'user' },
    ]);
  });

  test('renders only Agents when no terminal can exist', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    renderButtons();

    const group = screen.getByRole('group', { name: 'Panels' });
    expect(within(group).getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(within(group).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByTestId('header-pane-button-terminal')).toBeNull();
  });

  test('renders nothing, divider included, when the snapshot has no panes', () => {
    const { container } = renderButtons();

    expect(container.childElementCount).toBe(0);
    expect(screen.queryByTestId('header-pane-divider')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Panels' })).toBeNull();

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    });
    expect(screen.getByTestId('header-pane-divider')).toBeTruthy();
  });

  test('a click asks for the opposite of the shown state and leaves focus on the button', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    await user.click(agents);
    expect(document.activeElement).toBe(agents);
    await user.click(terminal);
    expect(document.activeElement).toBe(terminal);

    expect(requests).toEqual([
      { pane: 'agents', open: true, reason: 'user' },
      { pane: 'terminal', open: false, reason: 'user' },
    ]);
  });

  test('hiding a pane keeps focus on the button even when the pane hands focus elsewhere as it hides', async () => {
    const user = userEvent.setup();
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
    renderButtons();
    const elsewhere = document.createElement('div');
    elsewhere.tabIndex = -1;
    document.body.append(elsewhere);
    paneVisibilityStore.subscribeRequests(({ open }) => {
      if (!open) elsewhere.focus();
    });

    const terminal = screen.getByRole('button', { name: 'Terminal' });
    await user.click(terminal);
    await act(async () => {});

    expect(document.activeElement).toBe(terminal);
    elsewhere.remove();
  });

  test('each click acts on the state shown at that moment, not a local toggle', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    await user.click(agents);
    await user.click(agents);
    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: null });
    });
    await user.click(agents);

    expect(requests.map(({ open }) => open)).toEqual([true, true, false]);
  });

  test('Enter and Space on a focused button send the same request as a click', async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    renderButtons();

    const agents = screen.getByRole('button', { name: 'Agents' });
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    act(() => agents.focus());
    await user.keyboard('{Enter}');
    act(() => terminal.focus());
    await user.keyboard(' ');

    expect(requests).toEqual([
      { pane: 'agents', open: false, reason: 'user' },
      { pane: 'terminal', open: true, reason: 'user' },
    ]);
    expect(document.activeElement).toBe(terminal);
  });

  test.each([
    { platform: 'MacIntel', agents: '⌘ L', terminal: '⌘ J' },
    { platform: 'Win32', agents: 'Ctrl L', terminal: 'Ctrl J' },
    { platform: 'Linux x86_64', agents: 'Ctrl L', terminal: 'Ctrl J' },
  ])(
    'tooltips name the button and its $platform shortcut, the same in both states',
    async ({ platform, agents, terminal }) => {
      setPlatform(platform);
      const user = userEvent.setup();
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
      renderButtons();

      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agents' }));
      const agentsTooltip = await screen.findByRole('tooltip');
      expect(agentsTooltip.textContent).toBe(`Agents ${agents}`);
      expect(agentsTooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(agents);

      await user.tab();
      const terminalTooltip = await screen.findByRole('tooltip');
      expect(terminalTooltip.textContent).toBe(`Terminal ${terminal}`);

      act(() => {
        paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
      });
      expect((await screen.findByRole('tooltip')).textContent).toBe(`Terminal ${terminal}`);
      await user.hover(screen.getByRole('button', { name: 'Agents' }));
      expect((await screen.findByRole('tooltip', { name: /^Agents/ })).textContent).toBe(
        `Agents ${agents}`,
      );
    },
  );

  test('pressed buttons carry the tinted look, a hover tint of their own and a high-contrast outline', () => {
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    renderButtons();

    const on = screen.getByRole('button', { name: 'Agents' });
    const off = screen.getByRole('button', { name: 'Terminal' });
    expectVisualClassTokens(on.className, [
      ...PRESSED_LOOK,
      ...PRESSED_HOVER_LOOK,
      ...HIGH_CONTRAST_OUTLINE,
    ]);
    expectVisualClassTokensAbsent(on.className, ['hover:bg-muted', 'text-muted-foreground']);
    expectVisualClassTokens(off.className, ['text-muted-foreground', 'hover:bg-muted']);
    expectVisualClassTokensAbsent(off.className, [
      ...PRESSED_LOOK,
      ...PRESSED_HOVER_LOOK,
      ...HIGH_CONTRAST_OUTLINE,
    ]);
  });

  test('useHeaderPaneButtonSet lists the panes to render in header order', () => {
    render(
      <Providers setting={TERMINAL_SETTING_UNSET}>
        <PaneSetProbe />
      </Providers>,
    );
    const probe = screen.getByTestId('pane-set');
    expect(probe.textContent).toBe('');

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: null });
    });
    expect(probe.textContent).toBe('agents');

    act(() => {
      paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    });
    expect(probe.textContent).toBe('agents,terminal');
  });

  test('hides the Terminal button once the project settings say the terminal is off', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    renderButtons(TERMINAL_OFF);

    expect(paneButtonNames()).toEqual(['Agents']);
    expect(screen.queryByTestId('header-pane-button-terminal')).toBeNull();
    expect(screen.getByTestId('header-pane-divider')).toBeTruthy();
  });

  test.each([
    { state: 'while the project settings are still loading', setting: SETTINGS_LOADING },
    { state: 'when the terminal is turned on', setting: TERMINAL_ON },
    { state: 'when the project never set the terminal', setting: TERMINAL_SETTING_UNSET },
  ])('shows the Terminal button $state', ({ setting }) => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    renderButtons(setting);

    expect(paneButtonNames()).toEqual(['Agents', 'Terminal']);
  });

  test('keeps the Terminal button hidden while the settings rebind, until they say otherwise', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    const { setTerminalSetting } = renderButtons(TERMINAL_OFF);
    expect(paneButtonNames()).toEqual(['Agents']);

    setTerminalSetting(SETTINGS_LOADING);
    expect(paneButtonNames(), 'the button popped in while the settings rebound').toEqual([
      'Agents',
    ]);

    setTerminalSetting(TERMINAL_OFF);
    expect(paneButtonNames()).toEqual(['Agents']);

    setTerminalSetting(TERMINAL_ON);
    expect(paneButtonNames()).toEqual(['Agents', 'Terminal']);
  });

  test('turning the terminal on brings the Terminal button back at once, and turning it off hides it again', () => {
    paneVisibilityStore.publish({ editor: null, agents: SHOWN, terminal: HIDDEN });
    const { setTerminalSetting } = renderButtons(TERMINAL_OFF);
    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(paneButtonNames()).toEqual(['Agents']);

    setTerminalSetting(TERMINAL_ON);
    expect(paneButtonNames()).toEqual(['Agents', 'Terminal']);
    expect(screen.getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Agents' })).toBe(agents);

    setTerminalSetting(TERMINAL_OFF);
    expect(paneButtonNames()).toEqual(['Agents']);
  });

  test('keeps the Terminal button shown while the settings rebind after the terminal was turned on', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    const { setTerminalSetting } = renderButtons(TERMINAL_OFF);
    setTerminalSetting(TERMINAL_ON);
    const terminal = screen.getByRole('button', { name: 'Terminal' });

    setTerminalSetting(SETTINGS_LOADING);
    expect(screen.getByRole('button', { name: 'Terminal' })).toBe(terminal);
  });

  test('a terminal pane open on its enable notice still shows no Terminal button', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: SHOWN });
    renderButtons(TERMINAL_OFF);

    expect(paneVisibilityStore.getSnapshot().terminal?.open).toBe(true);
    expect(paneButtonNames()).toEqual(['Agents']);
    expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  test('useHeaderPaneButtonSet drops the terminal while it is turned off, so the header re-measures', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    const renderProbe = (setting: ProjectTerminalSetting) => (
      <Providers setting={setting}>
        <PaneSetProbe />
      </Providers>
    );
    const view = render(renderProbe(SETTINGS_LOADING));
    const probe = screen.getByTestId('pane-set');
    expect(probe.textContent).toBe('agents,terminal');

    view.rerender(renderProbe(TERMINAL_OFF));
    expect(probe.textContent).toBe('agents');

    view.rerender(renderProbe(SETTINGS_LOADING));
    expect(probe.textContent).toBe('agents');

    view.rerender(renderProbe(TERMINAL_ON));
    expect(probe.textContent).toBe('agents,terminal');
  });
});

describe('the Editor header button', () => {
  afterEach(() => {
    __resetPaneVisibilityStoreForTests();
    setPlatform(ORIGINAL_PLATFORM);
  });

  test('a project window lists Editor first, then Agents and Terminal', () => {
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: HIDDEN });
    renderButtons();

    const names = within(screen.getByRole('group', { name: 'Panels' }))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Editor', 'Agents', 'Terminal']);
    const editor = screen.getByTestId('header-pane-button-editor');
    expect(editor.getAttribute('data-size')).toBe('icon-sm');
    expect(editor.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('no Editor button appears where the snapshot has no editor pane', () => {
    paneVisibilityStore.publish({ editor: null, agents: HIDDEN, terminal: HIDDEN });
    renderButtons();

    expect(screen.queryByRole('button', { name: 'Editor' })).toBeNull();
  });

  test('its pressed state follows whether the editor is shown and it keeps its name', () => {
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();
    const editor = screen.getByRole('button', { name: 'Editor' });
    expect(editor.getAttribute('aria-pressed')).toBe('true');
    expectVisualClassTokens(editor.className, PRESSED_LOOK);

    act(() => {
      paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    });
    expect(editor.getAttribute('aria-pressed')).toBe('false');
    expect(editor.getAttribute('aria-label')).toBe('Editor');
    expectVisualClassTokensAbsent(editor.className, PRESSED_LOOK);
  });

  test('a click asks to hide a shown editor and show a hidden one, leaving focus on the button', async () => {
    const user = userEvent.setup();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();
    const editor = screen.getByRole('button', { name: 'Editor' });

    await user.click(editor);
    act(() => {
      paneVisibilityStore.publish({ editor: HIDDEN, agents: HIDDEN, terminal: null });
    });
    await user.keyboard('{Enter}');

    expect(requests).toEqual([
      { pane: 'editor', open: false, reason: 'user' },
      { pane: 'editor', open: true, reason: 'user' },
    ]);
    expect(document.activeElement).toBe(editor);
  });

  test('its tooltip names it with no shortcut, on hover and on keyboard focus', async () => {
    setPlatform('MacIntel');
    const user = userEvent.setup();
    paneVisibilityStore.publish({ editor: SHOWN, agents: HIDDEN, terminal: null });
    renderButtons();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Editor' }));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('Editor');
    expect(tooltip.querySelector('[data-slot="kbd"]')).toBeNull();
  });
});
