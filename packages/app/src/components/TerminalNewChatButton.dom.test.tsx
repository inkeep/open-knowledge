import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalNewChatButton, type TerminalNewTabChoice } from './TerminalNewChatButton';

function renderButton(selected: TerminalNewTabChoice = 'claude') {
  const onLaunchSelected = mock(() => {});
  const onPickCli = mock((_cli: TerminalCli) => {});
  const onPickTerminal = mock(() => {});
  render(
    <TooltipProvider>
      <TerminalNewChatButton
        selected={selected}
        onLaunchSelected={onLaunchSelected}
        onPickCli={onPickCli}
        onPickTerminal={onPickTerminal}
      />
    </TooltipProvider>,
  );
  return { onLaunchSelected, onPickCli, onPickTerminal };
}

describe('TerminalNewChatButton', () => {
  afterEach(() => cleanup());

  test('the primary launches the current selection (a CLI) without changing it', async () => {
    const user = userEvent.setup();
    const { onLaunchSelected, onPickCli } = renderButton('codex');

    await user.click(screen.getByRole('button', { name: 'New Codex chat' }));

    expect(onLaunchSelected).toHaveBeenCalledTimes(1);
    // Primary is a plain launch — it never re-picks.
    expect(onPickCli).not.toHaveBeenCalled();
  });

  test('when Terminal is the selection the primary opens a bare terminal', async () => {
    const user = userEvent.setup();
    const { onLaunchSelected, onPickTerminal } = renderButton('terminal');

    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(onLaunchSelected).toHaveBeenCalledTimes(1);
    expect(onPickTerminal).not.toHaveBeenCalled();
  });

  test('the dropdown lists every CLI plus a Terminal option', async () => {
    const user = userEvent.setup();
    renderButton('claude');

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));

    for (const name of ['Claude CLI', 'Codex CLI', 'OpenCode CLI', 'Cursor CLI']) {
      expect(await screen.findByRole('menuitem', { name })).toBeDefined();
    }
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeDefined();
  });

  test('picking a CLI from the dropdown switches the default (persist + launch)', async () => {
    const user = userEvent.setup();
    const { onPickCli, onLaunchSelected, onPickTerminal } = renderButton('claude');

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));
    await user.click(await screen.findByRole('menuitem', { name: 'OpenCode CLI' }));

    expect(onPickCli).toHaveBeenCalledTimes(1);
    expect(onPickCli).toHaveBeenCalledWith('opencode');
    expect(onLaunchSelected).not.toHaveBeenCalled();
    expect(onPickTerminal).not.toHaveBeenCalled();
  });

  test('marks the current pick with aria-current so it is in the a11y tree', async () => {
    const user = userEvent.setup();
    renderButton('codex');

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));

    // The active CLI row is programmatically current; siblings + Terminal are not.
    expect(
      (await screen.findByRole('menuitem', { name: 'Codex CLI' })).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Claude CLI' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'Terminal' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('marks the Terminal row current when a bare shell is the selection', async () => {
    const user = userEvent.setup();
    renderButton('terminal');

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));

    expect(
      (await screen.findByRole('menuitem', { name: 'Terminal' })).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('menuitem', { name: 'Claude CLI' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('picking Terminal from the dropdown switches the default to a bare shell', async () => {
    const user = userEvent.setup();
    const { onPickTerminal, onPickCli, onLaunchSelected } = renderButton('claude');

    await user.click(screen.getByRole('button', { name: 'Choose CLI for new chat' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }));

    expect(onPickTerminal).toHaveBeenCalledTimes(1);
    expect(onPickCli).not.toHaveBeenCalled();
    expect(onLaunchSelected).not.toHaveBeenCalled();
  });
});
