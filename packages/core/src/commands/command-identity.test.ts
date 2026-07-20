import { describe, expect, test } from 'bun:test';
import { MENU_LABELS } from '../constants/menu-labels.ts';
import {
  COMMAND_IDENTITIES,
  type CommandContext,
  evaluateCommandAvailability,
} from './command-identity.ts';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    host: 'desktop',
    activeTargetKind: 'doc',
    singleFile: false,
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

  // The load-bearing reconciliation: reveal/copy are actionable in the menu's
  // project scope but hidden in the palette with no target — one spec, two
  // contexts, because the menu projects project-scope to `project` and the
  // palette projects no-target to `none`.
  test('reveal/copy spec: project-scope actionable, no-target hidden', () => {
    const spec = { requiresTargetKinds: ['doc', 'folder', 'asset', 'project'] as const };
    // Menu: project scope → project → available.
    expect(evaluateCommandAvailability(spec, ctx({ activeTargetKind: 'project' }))).toBe(true);
    // Palette: no target → none → hidden.
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

  // Real commands combine gates (e.g. rename is host:desktop + requiresTargetKinds).
  // Pin the multi-gate path so a reorder or short-circuit interaction can't pass.
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

  test('every menu placement labelKey / stateToggle key resolves in MENU_LABELS', () => {
    for (const cmd of COMMAND_IDENTITIES) {
      if (cmd.stateToggle) {
        expect(MENU_LABELS[cmd.stateToggle.showKey]).toBeDefined();
        expect(MENU_LABELS[cmd.stateToggle.hideKey]).toBeDefined();
      }
      for (const placement of cmd.menu ?? []) {
        if (placement.menuLabelKey) expect(MENU_LABELS[placement.menuLabelKey]).toBeDefined();
        // A menu leaf must resolve to SOME label: an explicit literal, a menu
        // key override, or the command's own labelKey.
        const resolvable =
          placement.menuLabelText !== undefined ||
          placement.menuLabelKey !== undefined ||
          cmd.stateToggle !== undefined ||
          cmd.labelKey !== undefined;
        expect({ id: cmd.id, resolvable }).toEqual({ id: cmd.id, resolvable: true });
      }
    }
  });

  // Structural cure precondition: no command declares two placements that
  // resolve to the same platform (that is how a leaf gets hand-duplicated). The
  // palette-side Ratchet B extension asserts this against the rendered menu too.
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
