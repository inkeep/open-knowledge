import { COMMAND_IDENTITIES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { PaletteCommandContext } from '@/components/command-palette-commands';
import { PALETTE_COMMANDS } from '@/components/command-palette-commands';

function contextWith(viewMenuState: PaletteCommandContext['viewMenuState']): PaletteCommandContext {
  return { viewMenuState } as PaletteCommandContext;
}

const agentPanelRow = PALETTE_COMMANDS.find((cmd) => cmd.menuActionId === 'toggle-agent-panel');

describe('agents-panel label tracks selection, not just visibility', () => {
  test('the row exists and is the one ⌘L drives', () => {
    expect(agentPanelRow).toBeDefined();
    expect(agentPanelRow?.shortcutId).toBe('toggle-agent-panel');
  });

  test('with no selection it reads as the plain visibility toggle', () => {
    expect(agentPanelRow?.label(contextWith({ agentPanelVisible: false }))).toBe('Show Agents');
    expect(agentPanelRow?.label(contextWith({ agentPanelVisible: true }))).toBe('Hide Agents');
  });

  test('with a selection it names the staging, whatever the panel is doing', () => {
    expect(
      agentPanelRow?.label(contextWith({ agentPanelVisible: true, hasEditorSelection: true })),
    ).toBe('Ask AI About Selection');
    expect(
      agentPanelRow?.label(contextWith({ agentPanelVisible: false, hasEditorSelection: true })),
    ).toBe('Ask AI About Selection');
  });

  test('the override is declared on the shared registry, so the native menu reads it too', () => {
    const identity = COMMAND_IDENTITIES.find((cmd) => cmd.id === 'toggle-agent-panel');
    expect(identity?.stateToggle?.overrideKey).toBe('agentPanelAskSelection');
    expect(identity?.stateToggle?.overrideField).toBe('hasEditorSelection');
  });
});
