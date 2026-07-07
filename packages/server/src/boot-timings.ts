/**
 * Module-singleton accumulator for server boot-phase durations.
 *
 * Boot timing is captured here (rather than threaded through return values)
 * because the producers are scattered across `boot.ts` (HTTP listen) and the
 * background `initAsync` in `server-factory.ts` (seed walk, indexes, ready),
 * and the consumer (`GET /api/server-info`) is a third site that must read
 * whatever has accumulated so far. A module singleton lets each producer
 * record independently without passing a context object through the boot
 * call graph.
 *
 * All fields are BOUNDED numbers — millisecond durations, a file count, and
 * one ISO wall-clock string for cross-process alignment. No raw paths, doc
 * content, or free-form strings ever land here, so the object is safe to put
 * on the `/api/server-info` envelope and (downstream) on the desktop startup
 * waterfall log.
 *
 * Single-process test runners (`bun test`) boot many servers in one process,
 * so {@link resetBootTimingsForTest} clears the singleton between tests.
 */

export interface BootTimings {
  /** Wall-clock at boot start (ISO 8601) — cross-process clock alignment anchor. */
  startedAt: string;
  /** Time from boot start until `httpServer.listen` resolved. */
  httpListenMs?: number;
  /** Duration of the file-watcher startup seed walk (the O(n) disk scan). */
  seedWalkMs?: number;
  /** Combined duration of the boot-time index phases (backlink + tag + basename). */
  indexesMs?: number;
  /** Time from boot start until the `ready` promise resolved (end of initAsync). */
  readyMs?: number;
  /** Number of markdown files in the watcher's file index at ready time. */
  fileCount?: number;
}

let current: BootTimings | undefined;
let bootStartMono: number | undefined;

/**
 * Stamp the boot-start wall-clock and reset the accumulator. Called once at
 * the top of the boot sequence; subsequent phase records hang off this.
 * Also captures the monotonic origin so {@link bootElapsedMs} can derive
 * `readyMs` in the background `initAsync` without threading a start value
 * through the boot call graph.
 */
export function startBootTimings(startedAt: string = new Date().toISOString()): void {
  current = { startedAt };
  bootStartMono = performance.now();
}

/**
 * Milliseconds elapsed since {@link startBootTimings} captured the monotonic
 * origin, or `undefined` if boot timing was never started. Rounded to an
 * integer to keep the value bounded.
 */
export function bootElapsedMs(): number | undefined {
  if (bootStartMono === undefined) return undefined;
  return Math.round(performance.now() - bootStartMono);
}

/**
 * Record a single phase duration (ms). No-op if {@link startBootTimings} hasn't
 * run. The key excludes `fileCount` (a count, not a duration) so the
 * duration/count boundary is enforced at compile time — counts go through
 * {@link setBootField}.
 */
export function recordBootPhase(
  name: Exclude<keyof BootTimings, 'startedAt' | 'fileCount'>,
  ms: number,
): void {
  if (!current) return;
  current[name] = ms;
}

/**
 * Set a non-duration bounded field (e.g. `fileCount`). Kept distinct from
 * {@link recordBootPhase} so the duration-only fields stay typed as such.
 */
export function setBootField(name: 'fileCount', value: number): void {
  if (!current) return;
  current[name] = value;
}

/** Read the accumulated timings, or `undefined` if boot timing was never started. */
export function getBootTimings(): BootTimings | undefined {
  return current;
}

/** Test-only: drop the singleton so the next boot starts clean. */
export function resetBootTimingsForTest(): void {
  current = undefined;
  bootStartMono = undefined;
}
