import type { WaterfallPhase } from '../main/startup-waterfall.ts';

export const SPAWN_WAIT_HEARTBEAT_MS = 5_000;

export const SPAWN_STARTUP_DEADLINE_MS = 15_000;

export const UTILITY_INIT_TIMEOUT_MS = 20_000;

export const SPAWN_WAIT_EXTENSION_FACTOR = 8;

export function startupWaitHardCapMs(
  startupDeadlineMs: number,
  progressDeadlineMs?: number,
): number {
  return Math.max(
    startupDeadlineMs,
    progressDeadlineMs ?? startupDeadlineMs * SPAWN_WAIT_EXTENSION_FACTOR,
  );
}

export const UTILITY_INIT_HARD_CAP_MS = startupWaitHardCapMs(UTILITY_INIT_TIMEOUT_MS);

export const UTILITY_WAIT_EXTENDED_EVENT = 'desktop-utility-wait-extended';

export const UTILITY_WAIT_EXPIRED_EVENT = 'desktop-utility-wait-expired';

export const UTILITY_WAIT_LATE_KILL_EVENT = 'desktop-utility-wait-late-kill';

export const UTILITY_INIT_PHASES = [
  'init-received',
  'imports-resolved',
  'project-git-ensured',
  'boot-server-started',
] as const;

export type UtilityInitPhase = (typeof UTILITY_INIT_PHASES)[number];

export const UTILITY_INIT_COUNTERS = ['uptimeMs', 'cpuUserMs', 'cpuSystemMs'] as const;

export type UtilityInitCounters = Record<(typeof UTILITY_INIT_COUNTERS)[number], number>;

export function isUtilityInitPhase(value: unknown): value is UtilityInitPhase {
  return (UTILITY_INIT_PHASES as readonly unknown[]).includes(value);
}

export function utilityInitPhaseEvent(
  phase: UtilityInitPhase,
): `desktop-utility-init.${UtilityInitPhase}` {
  return `desktop-utility-init.${phase}`;
}

export const BOOT_HEARTBEAT_MAX_BEATS = 24;

export const DESKTOP_BOOT_EVENT = 'desktop.boot';

export const DESKTOP_OPEN_PROJECT_FAILED_EVENT = 'desktop-open-project-failed';

export const BOOT_HEARTBEAT_EVENTS = {
  boot: 'desktop-boot-progress',
  utilityWait: 'desktop-utility-wait-progress',
  spawnWait: 'desktop-spawn-wait-progress',
  rendererLoad: 'desktop-renderer-load-progress',
  navigatorLoad: 'desktop-navigator-load-progress',
} as const;

export const BOOT_HEARTBEAT_ABANDONED_SUFFIX = '-abandoned';

export type BootHeartbeatEvent = (typeof BOOT_HEARTBEAT_EVENTS)[keyof typeof BOOT_HEARTBEAT_EVENTS];

export function isBootHeartbeatEvent(event: string): boolean {
  const base = event.endsWith(BOOT_HEARTBEAT_ABANDONED_SUFFIX)
    ? event.slice(0, -BOOT_HEARTBEAT_ABANDONED_SUFFIX.length)
    : event;
  return (Object.values(BOOT_HEARTBEAT_EVENTS) as readonly string[]).includes(base);
}

const STARTUP_MARK_EVENT_PREFIX = 'desktop.startup.';

export function isStartupMarkEvent(event: string): boolean {
  return event.startsWith(STARTUP_MARK_EVENT_PREFIX);
}

export interface StartupMarkLine extends Record<string, unknown> {
  readonly event: `${typeof STARTUP_MARK_EVENT_PREFIX}${WaterfallPhase}`;
  readonly phase: WaterfallPhase;
  readonly elapsedMs: number;
}

export function startupMarkLine(phase: WaterfallPhase, elapsedMs: number): StartupMarkLine {
  return { event: `${STARTUP_MARK_EVENT_PREFIX}${phase}`, phase, elapsedMs };
}
