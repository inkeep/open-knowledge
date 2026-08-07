import { describe, expect, test } from 'vitest';
import {
  MIN_USABLE_RIGHT_TERMINAL_WIDTH_PX,
  minimumWorkspaceWidthForRightRailPeers,
  resolveRightRailAdmission,
} from './right-rail-admission';

// Boundary the rail can host both session columns at, derived rather than
// transcribed so a change to the terminal's floor moves the fixtures with it.
const BOTH_COLUMNS_FIT_PX = minimumWorkspaceWidthForRightRailPeers({
  otherRailWidthPx: 320,
  agentsMinimumWidthPx: 320,
});
const TOO_NARROW_PX = BOTH_COLUMNS_FIT_PX - 1;

describe('right rail admission', () => {
  test('admits both panels at the exact width that preserves the terminal floor', () => {
    const minimumWidth = BOTH_COLUMNS_FIT_PX;

    // Admission weighs the terminal at its drag floor, not its preferred width:
    // both columns coexist in far more windows than a 740px weighting allowed.
    expect(MIN_USABLE_RIGHT_TERMINAL_WIDTH_PX).toBe(324);
    expect(minimumWidth).toBe(1015);
    expect(
      resolveRightRailAdmission({
        workspaceWidthPx: minimumWidth,
        otherRailWidthPx: 320,
        agentsMinimumWidthPx: 320,
        previous: { terminalRightVisible: true, agentsVisible: false },
        current: { terminalRightVisible: true, agentsVisible: true },
        trigger: 'state-change',
      }),
    ).toEqual({ kind: 'none' });
  });

  test('moving the terminal right closes agents one pixel below the boundary', () => {
    expect(
      resolveRightRailAdmission({
        workspaceWidthPx: TOO_NARROW_PX,
        otherRailWidthPx: 320,
        agentsMinimumWidthPx: 320,
        previous: { terminalRightVisible: false, agentsVisible: true },
        current: { terminalRightVisible: true, agentsVisible: true },
        trigger: 'state-change',
      }),
    ).toEqual({ kind: 'close-agents' });
  });

  test('opening agents closes an existing right terminal when space is infeasible', () => {
    expect(
      resolveRightRailAdmission({
        workspaceWidthPx: TOO_NARROW_PX,
        otherRailWidthPx: 320,
        agentsMinimumWidthPx: 320,
        previous: { terminalRightVisible: true, agentsVisible: false },
        current: { terminalRightVisible: true, agentsVisible: true },
        trigger: 'state-change',
      }),
    ).toEqual({ kind: 'close-terminal' });
  });

  test('a resize into infeasibility keeps the terminal and closes agents', () => {
    const visibility = { terminalRightVisible: true, agentsVisible: true } as const;
    expect(
      resolveRightRailAdmission({
        workspaceWidthPx: TOO_NARROW_PX,
        otherRailWidthPx: 320,
        agentsMinimumWidthPx: 320,
        previous: visibility,
        current: visibility,
        trigger: 'resize',
      }),
    ).toEqual({ kind: 'close-agents' });
  });

  test.each([
    {
      name: 'closing agents',
      previous: { terminalRightVisible: true, agentsVisible: true },
      current: { terminalRightVisible: true, agentsVisible: false },
    },
    {
      name: 'closing the terminal',
      previous: { terminalRightVisible: true, agentsVisible: true },
      current: { terminalRightVisible: false, agentsVisible: true },
    },
    {
      name: 'a bottom terminal',
      previous: { terminalRightVisible: false, agentsVisible: true },
      current: { terminalRightVisible: false, agentsVisible: true },
    },
  ])('$name never opens the other panel', ({ previous, current }) => {
    expect(
      resolveRightRailAdmission({
        workspaceWidthPx: 900,
        otherRailWidthPx: 320,
        agentsMinimumWidthPx: 320,
        previous,
        current,
        trigger: 'state-change',
      }),
    ).toEqual({ kind: 'none' });
  });
});
