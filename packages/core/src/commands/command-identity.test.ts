import { describe, expect, test } from 'vitest';
import { MENU_LABELS } from '../constants/menu-labels.ts';
import {
  COMMAND_IDENTITIES,
  type CommandContext,
  DOCK_MOVE_COMMANDS,
  evaluateCommandAvailability,
} from './command-identity.ts';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    host: 'desktop',
    activeTargetKind: 'doc',
    singleFile: false,
    terminalCapable: true,
    terminalLive: false,
    canExpandAll: true,
    canCollapseAll: true,
    hasActiveDoc: true,
    showInstallSkill: true,
    ...overrides,
  };
}

describe('evaluateCommandAvailability', () => {
  test('empty spec is always available', () => {
    expect(evaluateCommandAvailability({}, ctx())).toBe(true);
    expect(evaluateCommandAvailability({}, ctx({ host: 'web', activeTargetKind: 'none' }))).toBe(
      true,
    );
  });

  test('host: desktop hides on web', () => {
    expect(evaluateCommandAvailability({ host: 'desktop' }, ctx({ host: 'web' }))).toBe(false);
    expect(evaluateCommandAvailability({ host: 'desktop' }, ctx({ host: 'desktop' }))).toBe(true);
    expect(evaluateCommandAvailability({ host: 'all' }, ctx({ host: 'web' }))).toBe(true);
  });

  test('requiresTargetKinds gates on the projected kind', () => {
    const spec = { requiresTargetKinds: ['doc', 'folder'] as const };
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'doc' }))).toBe(true);
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'folder' }))).toBe(true);
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'asset' }))).toBe(false);
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'none' }))).toBe(false);
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'project' }))).toBe(false);
  });

  test('reveal/copy spec: project-scope actionable, no-target hidden', () => {
    const spec = { requiresTargetKinds: ['doc', 'folder', 'asset', 'project'] as const };
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'project' }))).toBe(true);
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'none' }))).toBe(false);
  });

  test('singleFileHidden, terminalLive, expand/collapse, activeDoc, installSkill gates', () => {
    expect(evaluateCommandAvailability({ singleFileHidden: true }, ctx({ singleFile: true }))).toBe(
      false,
    );
    expect(
      evaluateCommandAvailability({ requiresTerminalLive: true }, ctx({ terminalLive: false })),
    ).toBe(false);
    expect(
      evaluateCommandAvailability({ requiresCanExpandAll: true }, ctx({ canExpandAll: false })),
    ).toBe(false);
    expect(
      evaluateCommandAvailability({ requiresCanCollapseAll: true }, ctx({ canCollapseAll: false })),
    ).toBe(false);
    expect(
      evaluateCommandAvailability({ requiresActiveDoc: true }, ctx({ hasActiveDoc: false })),
    ).toBe(false);
    expect(
      evaluateCommandAvailability({ requiresInstallSkill: true }, ctx({ showInstallSkill: false })),
    ).toBe(false);
  });

  test('requiresTerminalCapability gates on actual PTY support', () => {
    expect(
      evaluateCommandAvailability(
        { requiresTerminalCapability: true },
        ctx({ terminalCapable: false }),
      ),
    ).toBe(false);
    expect(
      evaluateCommandAvailability(
        { requiresTerminalCapability: true },
        ctx({ terminalCapable: true }),
      ),
    ).toBe(true);
  });

  test('compound gates: host AND target-kind must both pass', () => {
    const spec = { host: 'desktop', requiresTargetKinds: ['doc'] } as const;
    expect(evaluateCommandAvailability(spec, ctx({ host: 'web', activeTargetKind: 'doc' }))).toBe(
      false,
    );
    expect(
      evaluateCommandAvailability(spec, ctx({ host: 'desktop', activeTargetKind: 'asset' })),
    ).toBe(false);
    expect(
      evaluateCommandAvailability(spec, ctx({ host: 'desktop', activeTargetKind: 'doc' })),
    ).toBe(true);
  });
});

describe('COMMAND_IDENTITIES registry invariants', () => {
  test('every PTY-backed palette command declares the terminal capability gate', () => {
    const gatedIds = COMMAND_IDENTITIES.filter(
      (command) => command.palette && command.availability.requiresTerminalCapability,
    ).map((command) => command.id);

    expect(gatedIds).toEqual([
      'toggle-terminal',
      'new-terminal',
      'move-terminal',
      'kill-terminal',
      'move-terminal-left',
      'move-terminal-right',
      'move-terminal-top',
      'move-terminal-bottom',
    ]);
  });

  test('the menu-only terminal window command declares the terminal capability gate', () => {
    const command = COMMAND_IDENTITIES.find((entry) => entry.id === 'new-terminal-window');
    expect(command?.availability.requiresTerminalCapability).toBe(true);
  });

  test('command ids are unique', () => {
    const ids = COMMAND_IDENTITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('menuActionIds are unique among commands that declare one', () => {
    const actionIds = COMMAND_IDENTITIES.flatMap((c) => (c.menuActionId ? [c.menuActionId] : []));
    expect(new Set(actionIds).size).toBe(actionIds.length);
  });

  test('every palette command has a labelKey that resolves in MENU_LABELS', () => {
    for (const cmd of COMMAND_IDENTITIES) {
      if (!cmd.palette) continue;
      expect(cmd.labelKey).toBeDefined();
      expect(MENU_LABELS[cmd.labelKey as keyof typeof MENU_LABELS]).toBeDefined();
    }
  });

  test('every menu placement and dynamic label key resolves in MENU_LABELS', () => {
    for (const cmd of COMMAND_IDENTITIES) {
      if (cmd.stateToggle) {
        expect(MENU_LABELS[cmd.stateToggle.showKey]).toBeDefined();
        expect(MENU_LABELS[cmd.stateToggle.hideKey]).toBeDefined();
      }
      if (cmd.placementToggle) {
        expect(MENU_LABELS[cmd.placementToggle.bottomKey]).toBeDefined();
        expect(MENU_LABELS[cmd.placementToggle.rightKey]).toBeDefined();
      }
      for (const placement of cmd.menu ?? []) {
        if (placement.menuLabelKey) expect(MENU_LABELS[placement.menuLabelKey]).toBeDefined();
        const resolvable =
          placement.menuLabelText !== undefined ||
          placement.menuLabelKey !== undefined ||
          cmd.stateToggle !== undefined ||
          cmd.placementToggle !== undefined ||
          cmd.labelKey !== undefined;
        expect({ id: cmd.id, resolvable }).toEqual({ id: cmd.id, resolvable: true });
      }
    }
  });

  test('no command has two menu placements for the same platform', () => {
    for (const cmd of COMMAND_IDENTITIES) {
      const platforms = (cmd.menu ?? []).map((p) => p.platform ?? 'all');
      const macCount = platforms.filter((p) => p === 'all' || p === 'mac').length;
      const otherCount = platforms.filter((p) => p === 'all' || p === 'other').length;
      expect({ id: cmd.id, macCount: macCount <= 1, otherCount: otherCount <= 1 }).toEqual({
        id: cmd.id,
        macCount: true,
        otherCount: true,
      });
    }
  });
});

describe('dock move commands', () => {
  test('every pane can be moved to every edge, each by one search-only command', () => {
    const moves = DOCK_MOVE_COMMANDS.map((command) => `${command.pane}:${command.side}`);
    expect(moves.toSorted()).toEqual(
      ['editor', 'agents', 'terminal']
        .flatMap((pane) => ['left', 'right', 'top', 'bottom'].map((side) => `${pane}:${side}`))
        .toSorted(),
    );
    for (const command of DOCK_MOVE_COMMANDS) {
      const identity = COMMAND_IDENTITIES.find((entry) => entry.id === command.id);
      expect(identity?.palette?.visibility).toBe('search-only');
    }
  });

  test.each([
    ['move-editor-left', 'Move Editor to the left edge of the window'],
    ['move-editor-right', 'Move Editor to the right edge of the window'],
    ['move-editor-top', 'Move Editor to the top edge of the window'],
    ['move-editor-bottom', 'Move Editor to the bottom edge of the window'],
    ['move-agents-left', 'Move Agents to the left edge of the window'],
    ['move-agents-right', 'Move Agents to the right edge of the window'],
    ['move-agents-top', 'Move Agents to the top edge of the window'],
    ['move-agents-bottom', 'Move Agents to the bottom edge of the window'],
    ['move-terminal-left', 'Move Terminal to the left edge of the window'],
    ['move-terminal-right', 'Move Terminal to the right edge of the window'],
    ['move-terminal-top', 'Move Terminal to the top edge of the window'],
    ['move-terminal-bottom', 'Move Terminal to the bottom edge of the window'],
  ])('%s is labelled "%s"', (id, label) => {
    const identity = COMMAND_IDENTITIES.find((entry) => entry.id === id);
    expect(identity?.labelKey === undefined ? undefined : MENU_LABELS[identity.labelKey]).toBe(
      label,
    );
  });
});
