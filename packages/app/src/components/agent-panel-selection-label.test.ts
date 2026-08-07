/**
 * ⌘L renames itself when a selection is live.
 *
 * The chord carries two behaviors — toggle the agents panel, or stage the
 * selection in it — so a Show/Hide pair alone leaves the item claiming "Hide
 * Agents" while the click stages a passage and the panel stays open. That is the
 * failure this pins: not that some third label exists, but that the label stops
 * naming the toggle exactly when the command stops performing one.
 *
 * The native menu resolves the same `stateToggle` through `menuLeafLabel` in
 * `packages/desktop/src/main/menu.ts`. That module needs Electron and has no
 * unit test, so this covers the renderer half of a contract both halves read
 * from the shared command registry.
 */

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
    // Both visibility states, because the bug was specifically that an OPEN
    // panel advertised "Hide Agents" and then did not hide.
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
