import { afterEach, describe, expect, test } from 'bun:test';
import type { HandoffTarget, InstallState } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditWithAiPanel } from './EditWithAiPopover';

afterEach(() => {
  cleanup();
});

function installStates(
  flags: Partial<Record<HandoffTarget, boolean | null>>,
): Record<HandoffTarget, InstallState> {
  const at = (id: HandoffTarget): InstallState => ({ installed: flags[id] ?? null });
  return {
    'claude-cowork': at('claude-cowork'),
    'claude-code': at('claude-code'),
    codex: at('codex'),
    cursor: at('cursor'),
  };
}

describe('EditWithAiPanel', () => {
  test('renders the instruction input and one button per installed agent', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': true, codex: true })}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-with-ai-instruction')).toBeTruthy();
    expect(screen.getByTestId('edit-with-ai-target-claude-code')).toBeTruthy();
    expect(screen.getByTestId('edit-with-ai-target-codex')).toBeTruthy();
  });

  test('hides agents that are not installed or still being probed', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': true, codex: false, cursor: null })}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-with-ai-target-claude-code')).toBeTruthy();
    expect(screen.queryByTestId('edit-with-ai-target-codex')).toBeNull();
    expect(screen.queryByTestId('edit-with-ai-target-cursor')).toBeNull();
  });

  test('never renders the cowork target even when it is installed', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-cowork': true, codex: true })}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByTestId('edit-with-ai-target-claude-cowork')).toBeNull();
  });

  test('renders no claude.ai web-fallback row', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': false, codex: false, cursor: false })}
        onPick={() => {}}
      />,
    );
    expect(screen.queryByText(/claude\.ai/i)).toBeNull();
  });

  test('picking an agent reports the target and the typed instruction', async () => {
    const user = userEvent.setup();
    const picks: Array<{ id: string; instruction: string }> = [];
    render(
      <EditWithAiPanel
        installStates={installStates({ codex: true })}
        onPick={(target, instruction) => picks.push({ id: target.id, instruction })}
      />,
    );
    await user.type(screen.getByTestId('edit-with-ai-instruction'), 'tighten the prose');
    await user.click(screen.getByTestId('edit-with-ai-target-codex'));
    expect(picks).toEqual([{ id: 'codex', instruction: 'tighten the prose' }]);
  });

  test('allows a pick with an empty instruction', async () => {
    const user = userEvent.setup();
    const picks: Array<{ id: string; instruction: string }> = [];
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': true })}
        onPick={(target, instruction) => picks.push({ id: target.id, instruction })}
      />,
    );
    await user.click(screen.getByTestId('edit-with-ai-target-claude-code'));
    expect(picks).toEqual([{ id: 'claude-code', instruction: '' }]);
  });

  test('shows an empty state when no agents are installed', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': false, codex: false, cursor: false })}
        onPick={() => {}}
      />,
    );
    const empty = screen.getByTestId('edit-with-ai-empty');
    expect(empty).toBeTruthy();
    expect(screen.queryByTestId('edit-with-ai-target-claude-code')).toBeNull();
  });

  test('the install-state region is an aria-live region so its async transition is announced', () => {
    render(
      <EditWithAiPanel
        installStates={installStates({ 'claude-code': null, codex: null, cursor: null })}
        onPick={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-with-ai-empty').getAttribute('aria-live')).toBe('polite');
  });
});
