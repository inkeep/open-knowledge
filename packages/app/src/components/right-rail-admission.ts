import { MIN_TERMINAL_RIGHT_WIDTH } from '@inkeep/open-knowledge-core';

// Admission asks whether both rail columns can coexist at all, so it weighs the
// terminal at its drag floor rather than its preferred width. Weighing it at the
// preferred width would evict the agent panel from windows where the user is
// perfectly willing to run a narrower terminal.
export const MIN_USABLE_RIGHT_TERMINAL_WIDTH_PX = MIN_TERMINAL_RIGHT_WIDTH;

// react-resizable-panels converts pixel constraints through percentages. One
// extra pixel absorbs percentage and device-pixel rounding at the rendered edge.
export const RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX = MIN_USABLE_RIGHT_TERMINAL_WIDTH_PX + 1;

const EDITOR_RESIDUAL_FRACTION = 0.05;

interface RightRailVisibility {
  readonly terminalRightVisible: boolean;
  readonly agentsVisible: boolean;
}

interface RightRailAdmissionInput {
  readonly workspaceWidthPx: number;
  readonly otherRailWidthPx: number;
  readonly agentsMinimumWidthPx: number;
  readonly previous: RightRailVisibility;
  readonly current: RightRailVisibility;
  readonly trigger: 'state-change' | 'resize';
}

export type RightRailAdmissionDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'close-agents' }
  | { readonly kind: 'close-terminal' };

export function minimumWorkspaceWidthForRightRailPeers({
  otherRailWidthPx,
  agentsMinimumWidthPx,
}: {
  readonly otherRailWidthPx: number;
  readonly agentsMinimumWidthPx: number;
}): number {
  const peerWidthPx = otherRailWidthPx + agentsMinimumWidthPx + MIN_USABLE_RIGHT_TERMINAL_WIDTH_PX;
  return Math.ceil(peerWidthPx / (1 - EDITOR_RESIDUAL_FRACTION));
}

export function resolveRightRailAdmission({
  workspaceWidthPx,
  otherRailWidthPx,
  agentsMinimumWidthPx,
  previous,
  current,
  trigger,
}: RightRailAdmissionInput): RightRailAdmissionDecision {
  if (!current.terminalRightVisible || !current.agentsVisible) return { kind: 'none' };

  const minimumWidthPx = minimumWorkspaceWidthForRightRailPeers({
    otherRailWidthPx,
    agentsMinimumWidthPx,
  });
  if (workspaceWidthPx >= minimumWidthPx) return { kind: 'none' };
  if (trigger === 'resize') return { kind: 'close-agents' };

  const agentsJustOpened = !previous.agentsVisible && current.agentsVisible;
  const terminalWasAlreadyRight = previous.terminalRightVisible;
  return agentsJustOpened && terminalWasAlreadyRight
    ? { kind: 'close-terminal' }
    : { kind: 'close-agents' };
}
