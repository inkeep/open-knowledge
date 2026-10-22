export const QUIT_DRAIN_FLAG = {
  workerEvents: 0,
  shutdownReceived: 1,
  nativeOpsPending: 2,
  nativeOpsStartedDuringShutdown: 3,
  nativeSubscribes: 4,
  nativeUnsubscribes: 5,
  holdsBegun: 6,
  holdsReleased: 7,
  deliverParentMessagesOnRelease: 8,
  serverStartSettled: 9,
  serverInitSettled: 10,
  exitCalled: 11,
  exitCode: 12,
  nativeOpsPendingAtExit: 13,
  subscriptionsUnreleasedAtExit: 14,
  serverStartSettledAtExit: 15,
} as const;

export const QUIT_DRAIN_FLAG_COUNT = Object.keys(QUIT_DRAIN_FLAG).length;

export const QUIT_DRAIN_MODES = ['quit-after-start', 'quit-during-start'] as const;
export type QuitDrainMode = (typeof QUIT_DRAIN_MODES)[number];

export function isQuitDrainMode(value: unknown): value is QuitDrainMode {
  return QUIT_DRAIN_MODES.some((mode) => mode === value);
}

export interface QuitDrainHarnessResult {
  readonly mode: QuitDrainMode;
  readonly quitBeganWithNativeWorkHeld: boolean;
  readonly shutdownPostedToUtility: boolean;
  readonly nativeOpsStartedDuringShutdown: number;
  readonly nativeWorkReleasedWhileQuitHeld: number;
  readonly teardown: 'utility-exited' | 'native-work-held';
  readonly nativeOpsPendingAtTeardown: number;
  readonly nativeSubscribes: number;
  readonly utilityExitCode: number | null;
  readonly nativeOpsPendingAtExit: number | null;
  readonly subscriptionsUnreleasedAtExit: number | null;
  readonly serverStartSettledBeforeExit: boolean | null;
  readonly projectOpenOutcome: string | null;
}

export const QUIT_DRAIN_RESULT_PREFIX = 'quit-drain-harness-result ';
