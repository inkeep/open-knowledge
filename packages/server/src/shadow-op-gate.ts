/**
 * Shadow-repo operation gate — mutual exclusion between shadow git MUTATIONS
 * (object/ref writes: commitWip, buildWipTree, saveVersion, checkpoints, park,
 * ref sweeps) and the maintenance GC leg.
 *
 * Why: `git gc` (repack + prune/prune-packed) deletes newly-packed loose
 * objects and removes now-empty `objects/xx/` fan-out directories. A concurrent
 * `git add`/`hash-object -w` creates its temporary object file inside those
 * same directories; when gc removes a directory in the race window the write
 * fails (`unable to create temporary file` → `fatal: updating files failed`).
 * git only retries its internal mkdir fallback on ENOENT, and the raced state
 * can surface other errnos (EINVAL observed on macOS), so the failure escapes
 * to the caller — in production, a transiently failed user-content flush
 * commit. The MaintenanceCoordinator's own gate serializes maintenance ops
 * against each other but not against the write path; this gate closes that gap.
 *
 * Semantics (deadlock-free by construction):
 * - `withMutator` (shared): waits only while an exclusive op HOLDS the gate,
 *   then runs concurrently with other mutators. A *pending* exclusive request
 *   does NOT block new mutators, so nested mutator calls (e.g. saveVersion
 *   internally driving further ref updates) can never deadlock against a
 *   waiting gc. Shared holders never wait while holding.
 * - `withExclusive` (gc): serializes against other exclusives, then waits for
 *   in-flight mutators to drain to zero, then holds the gate — new mutators
 *   queue until it releases. The exclusive holder never waits while holding.
 *
 * Trade-offs: gc can be starved under a continuous mutator stream — acceptable
 * because flush commits are debounced/bursty and gc is opportunistic
 * (skip-and-retry-next-trigger posture). Mutators can queue behind a long gc;
 * shadow flushes are background persistence (debounced off the CRDT hot path),
 * so a paused flush delays durability, not user-visible editing.
 *
 * Gates are registered per shadow gitDir (not per handle object) so every
 * handle pointing at the same shadow repo shares one gate, including handles
 * recreated across boots within one process.
 */

import { getLogger } from './logger.ts';

const log = getLogger('shadow-op-gate');

/**
 * Warn when an exclusive (gc) acquisition waited longer than this for the
 * mutator drain. Purely diagnostic — the documented starvation posture is
 * unchanged; this makes it observable if the production write profile turns
 * out to be less bursty than assumed.
 */
const EXCLUSIVE_WAIT_WARN_MS = 60_000;

export class ShadowOpGate {
  private mutatorCount = 0;
  /** Non-null exactly while an exclusive op holds the gate. */
  private exclusiveHeld: Promise<void> | null = null;
  private drainWaiters: Array<() => void> = [];

  /** Number of in-flight mutator holds (diagnostics/tests). */
  get activeMutators(): number {
    return this.mutatorCount;
  }

  /** True while an exclusive (gc) op holds the gate (diagnostics/tests). */
  get isExclusiveHeld(): boolean {
    return this.exclusiveHeld !== null;
  }

  async withMutator<T>(fn: () => Promise<T>): Promise<T> {
    // Wait only while an exclusive op HOLDS the gate. Re-check after each wake:
    // another exclusive may have acquired between the release and this
    // continuation running.
    while (this.exclusiveHeld) await this.exclusiveHeld;
    this.mutatorCount += 1;
    try {
      return await fn();
    } finally {
      this.mutatorCount -= 1;
      if (this.mutatorCount === 0) {
        for (const wake of this.drainWaiters.splice(0)) wake();
      }
    }
  }

  async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Acquire: no exclusive holder AND zero in-flight mutators. Both
    // conditions re-check after every wake in ONE loop — a wake from either
    // wait may race another exclusive acquiring first (the coordinator's own
    // gate already ensures one maintenance op at a time; this keeps the gate
    // safe standalone). New mutators may still enter while we wait for the
    // drain (no barging — that is what makes nested mutator holds
    // deadlock-free).
    const waitStart = performance.now();
    for (;;) {
      if (this.exclusiveHeld) {
        await this.exclusiveHeld;
        continue;
      }
      if (this.mutatorCount > 0) {
        await new Promise<void>((r) => {
          this.drainWaiters.push(r);
        });
        continue;
      }
      break;
    }
    const waitedMs = performance.now() - waitStart;
    if (waitedMs > EXCLUSIVE_WAIT_WARN_MS) {
      log.warn(
        { waitedMs: Math.round(waitedMs) },
        '[shadow-op-gate] exclusive acquisition waited a long time for the mutator drain — sustained write stream is starving maintenance',
      );
    }
    // Both conditions held on a synchronous check just now — acquire before
    // any other task can observe the gate un-held.
    let release!: () => void;
    this.exclusiveHeld = new Promise<void>((r) => {
      release = r;
    });
    try {
      return await fn();
    } finally {
      this.exclusiveHeld = null;
      release();
    }
  }
}

const gates = new Map<string, ShadowOpGate>();

/** The shared per-shadow-repo gate, keyed by the shadow's gitDir. */
export function shadowOpGateFor(shadow: { gitDir: string }): ShadowOpGate {
  let gate = gates.get(shadow.gitDir);
  if (!gate) {
    gate = new ShadowOpGate();
    gates.set(shadow.gitDir, gate);
  }
  return gate;
}

/** Drop the registry entry for a shadow repo (graceful shutdown / tests). */
export function releaseShadowOpGate(gitDir: string): void {
  gates.delete(gitDir);
}
