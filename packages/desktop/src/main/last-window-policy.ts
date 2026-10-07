export interface AllWindowsClosedInput {
  platform: NodeJS.Platform;
  lastClosedWasNavigator: boolean;
  sessionEnding: boolean;
}

export type AllWindowsClosedAction = 'stay' | 'quit' | 'open-navigator';

export function decideAllWindowsClosed(input: AllWindowsClosedInput): AllWindowsClosedAction {
  if (input.platform === 'darwin') return 'stay';
  if (input.sessionEnding) return 'quit';
  if (input.lastClosedWasNavigator) return 'quit';
  return 'open-navigator';
}

export interface RelaunchWindowCandidate {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export interface RelaunchRevealInput<W extends RelaunchWindowCandidate> {
  lastFocusedWindow: W | null;
  windows: readonly W[];
  firstWindowShown: boolean;
}

export type RelaunchRevealDecision<W extends RelaunchWindowCandidate> =
  | { action: 'reveal'; window: W }
  | { action: 'open-navigator' }
  | { action: 'none' };

export function decideRelaunchReveal<W extends RelaunchWindowCandidate>(
  input: RelaunchRevealInput<W>,
): RelaunchRevealDecision<W> {
  const target = [input.lastFocusedWindow, ...input.windows].find(
    (win): win is W => win !== null && !win.isDestroyed() && (win.isVisible() || win.isMinimized()),
  );
  if (target) return { action: 'reveal', window: target };
  if (input.firstWindowShown && input.windows.length === 0) return { action: 'open-navigator' };
  return { action: 'none' };
}
