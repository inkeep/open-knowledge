import type { WaterfallPhase } from '../main/startup-waterfall.ts';

export const SPAWN_WAIT_HEARTBEAT_MS = 5_000;

export const SPAWN_STARTUP_DEADLINE_MS = 15_000;

export const UTILITY_INIT_TIMEOUT_MS = 15_000;

export const SPAWN_WAIT_EXTENSION_FACTOR = 8;

export const BOOT_HEARTBEAT_MAX_BEATS = 24;

export const DESKTOP_BOOT_EVENT = 'desktop.boot';

export const BOOT_HEARTBEAT_EVENTS = {
  boot: 'desktop-boot-progress',
  utilityWait: 'desktop-utility-wait-progress',
  spawnWait: 'desktop-spawn-wait-progress',
  rendererLoad: 'desktop-renderer-load-progress',
  navigatorLoad: 'desktop-navigator-load-progress',
} as const;

export const BOOT_HEARTBEAT_ABANDONED_SUFFIX = '-abandoned';

export type BootHeartbeatEvent = (typeof BOOT_HEARTBEAT_EVENTS)[keyof typeof BOOT_HEARTBEAT_EVENTS];

/** @lintignore knip reports this unused without the marker: its only consumer is tests/smoke/_helpers/launch-readiness.ts, which this package's knip project (src/**) does not analyze. Verified by deleting this line and running knip. */
export function isBootHeartbeatEvent(event: string): boolean {
  const base = event.endsWith(BOOT_HEARTBEAT_ABANDONED_SUFFIX)
    ? event.slice(0, -BOOT_HEARTBEAT_ABANDONED_SUFFIX.length)
    : event;
  return (Object.values(BOOT_HEARTBEAT_EVENTS) as readonly string[]).includes(base);
}

const STARTUP_MARK_EVENT_PREFIX = 'desktop.startup.';

export interface StartupMarkLine extends Record<string, unknown> {
  readonly event: `${typeof STARTUP_MARK_EVENT_PREFIX}${WaterfallPhase}`;
  readonly phase: WaterfallPhase;
  readonly elapsedMs: number;
}

export function startupMarkLine(phase: WaterfallPhase, elapsedMs: number): StartupMarkLine {
  return { event: `${STARTUP_MARK_EVENT_PREFIX}${phase}`, phase, elapsedMs };
}
