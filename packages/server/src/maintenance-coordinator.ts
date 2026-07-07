/**
 * Shadow-repo maintenance coordinator.
 *
 * A single in-process gate that serializes all maintenance ops (gc, and — in
 * later stories — auto-consolidation and the TTL reap) so at most one runs at a
 * time. Maintenance runs OFF the write path: triggers (boot, post-flush-counter,
 * session-close, post-consolidation) call in here, never the commit path, and gc
 * runs under a dedicated long timeout (`MAINTENANCE_GIT_TIMEOUT_MS`) rather than
 * the 30s block watchdog, so a large backlog packs without being killed.
 *
 * Concurrency posture mirrors the proven `rename-log` `gcPending` gate: skip if
 * busy (the op retries on the next trigger) rather than queue. The master kill
 * switch `OK_SHADOW_MAINTENANCE_DISABLED=1` disables the whole subsystem.
 */
import { getLogger } from './logger.ts';
import { gcShadowBranches } from './shadow-branch-gc.ts';
import {
  type ConsolidationTriggerLabel,
  recordConsolidation,
  recordGcLatch,
  recordMaintenanceRun,
} from './shadow-maintenance-telemetry.ts';
import type { ShadowHandle, WriterIdentity } from './shadow-repo.ts';
import {
  enumerateWipChains,
  MAINTENANCE_GIT_TIMEOUT_MS,
  saveVersion,
  shadowGit,
} from './shadow-repo.ts';
import { countShadowObjects, countWipRefs, hasGcLogLatch } from './shadow-repo-stats.ts';

const log = getLogger('shadow-maintenance');

/**
 * Dead AGENT chains must reach this count before auto-consolidation fires
 * Only `agent-*` refs with no live keepalive count; principal-*
 * and classified writers never count toward the trigger. Env-escapable.
 */
const DEAD_CHAIN_THRESHOLD = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_DEAD_CHAIN_THRESHOLD;
  if (!raw) return 5;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

/** Minimum spacing between auto-consolidation runs. Default 10 min. */
const CONSOLIDATION_MIN_SPACING_MS = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_CONSOLIDATION_SPACING_MS;
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
})();

/** Master kill switch — disables the entire maintenance subsystem. */
function isMaintenanceDisabled(): boolean {
  return process.env.OK_SHADOW_MAINTENANCE_DISABLED === '1';
}

/** Map a coordinator trigger to the typed auto-consolidation trigger label. */
function consolidationTriggerLabel(trigger: string): ConsolidationTriggerLabel {
  if (trigger === 'boot') return 'boot';
  if (trigger === 'session-close') return 'session-close';
  if (trigger === 'ttl') return 'ttl';
  return 'dead-chain'; // flush-counter and any other → the dead-chain check
}

type GcSkipReason = 'disabled' | 'busy' | 'no-shadow' | 'error';

export interface GcRunResult {
  /** True only when `git gc --auto` actually executed (regardless of whether it
   *  decided to pack — under the gc.auto threshold it is a no-op). */
  ran: boolean;
  skipped?: GcSkipReason;
  looseBefore?: number;
  looseAfter?: number;
  packfilesAfter?: number;
  /** True if a gc.log latch was observed after the run (auto-gc disabled). */
  latch?: boolean;
  durationMs?: number;
}

export interface MaintenanceCoordinatorDeps {
  /** Resolve the live shadow handle (deferred-init aware — may be null early). */
  getShadow: () => ShadowHandle | null;
  /**
   * Active project branch — consolidation is branch-scoped. Absent disables
   * auto-consolidation (gc still runs). Threaded so the auto path operates on the
   * branch the user is actually on, not a hardcoded 'main'.
   */
  getCurrentBranch?: () => string | null;
  /** Content root for the consolidation checkpoint's full-tree snapshot. */
  contentRoot?: string;
  /**
   * True if the writer (`agent-<connectionId>`) currently has a live keepalive
   * session. A dead chain is an `agent-*` ref for which this returns false.
   * Absent disables auto-consolidation (cannot tell dead from live).
   */
  isWriterLive?: (writerId: string) => boolean;
  /**
   * The project's git dir (e.g. `<projectRoot>/.git`). Required for the TTL
   * backstop reap (it compares shadow branches against project branches);
   * absent disables the reap leg.
   */
  projectGitDir?: string;
}

/** Fire a background gc every ~this-many shadow flush commits. */
export const FLUSH_GC_INTERVAL = 200;

type ConsolidationSkipReason =
  | 'disabled'
  | 'unconfigured'
  | 'busy'
  | 'no-shadow'
  | 'spacing'
  | 'below-threshold'
  | 'error';

export interface ConsolidationResult {
  consolidated: boolean;
  skipped?: ConsolidationSkipReason;
  /** Number of dead agent chains folded (when consolidated) or found (when below threshold). */
  deadChains?: number;
  widthBefore?: number;
  widthAfter?: number;
}

export class MaintenanceCoordinator {
  private running = false;
  private destroyed = false;
  private flushCommitCounter = 0;
  private lastConsolidationAt = 0;
  /**
   * Last observed gc.log latch state, so the latch counter increments once per
   * distinct latch EPISODE (absent→present transition) rather than on every run
   * that observes a persistent latch — otherwise `rate(gc_latch_total)` can't
   * tell one ~24h latch from many short ones. The per-run warning log still
   * fires every time, so a persistent latch stays visible in logs.
   */
  private lastGcLatch = false;

  constructor(private readonly deps: MaintenanceCoordinatorDeps) {}

  /** Whether a maintenance op is currently running (diagnostics/tests). */
  get isRunning(): boolean {
    return this.running;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Called on each successful shadow flush-commit (persistence write path). Cheap
   * — just a counter bump — and fires a background gc every `FLUSH_GC_INTERVAL`
   * commits. Fire-and-forget so the write path is never blocked; the gc is
   * coordinator-gated (skips if busy).
   */
  noteFlushCommit(): void {
    if (isMaintenanceDisabled() || this.destroyed) return;
    this.flushCommitCounter += 1;
    if (this.flushCommitCounter >= FLUSH_GC_INTERVAL) {
      this.flushCommitCounter = 0;
      void this.runScheduledMaintenance('flush-counter');
    }
  }

  /**
   * Boot maintenance: time-capped (default ≤ 1s of boot blocking) with
   * background continuation for a large backlog, mirroring the existing boot-GC
   * `Promise.race` precedent. The op keeps running after the cap; we only stop
   * AWAITING it so boot proceeds.
   */
  async runBootMaintenance(capMs = 1000): Promise<void> {
    if (isMaintenanceDisabled() || this.destroyed) return;
    const work = this.runScheduledMaintenance('boot');
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((r) => {
      capTimer = setTimeout(r, capMs);
    });
    await Promise.race([work.then(() => undefined), cap]);
    if (capTimer) clearTimeout(capTimer);
    // Background continuation — the inner legs each catch their own errors, so a
    // rejection here is an unexpected path. Log it (rather than swallowing) so a
    // rare late failure after boot moved on stays diagnosable, while still
    // preventing it from surfacing as an unhandled rejection.
    void work.catch((err) => {
      log.warn({ err }, '[shadow-maintenance] boot maintenance background continuation failed');
    });
  }

  /**
   * Session-close trigger (keepalive grace path). A closed agent session may
   * have left a dead chain behind; evaluate maintenance off the write path.
   */
  async onSessionClose(): Promise<void> {
    await this.runScheduledMaintenance('session-close');
  }

  /**
   * The maintenance run for a scheduled trigger: dead-chain auto-consolidation,
   * then the TTL backstop reap, then gc. Each is independently
   * gated; consolidation + reap fold chains and leave loose objects the gc packs.
   */
  private async runScheduledMaintenance(trigger: string): Promise<void> {
    if (isMaintenanceDisabled() || this.destroyed) return;
    // The single gate is held across the WHOLE compound run (consolidate -> reap
    // -> gc), not re-acquired per leg, so a concurrent trigger cannot interleave
    // its own consolidate between this run's reap and gc. The legs run via the
    // *Inner methods that do the work WITHOUT touching the gate; the public
    // per-leg methods below are thin gated wrappers for direct/test callers.
    if (this.running) return;
    this.running = true;
    try {
      await this.consolidateInner(trigger);
      await this.reapInner(trigger);
      await this.gcInner(trigger);
    } finally {
      this.running = false;
    }
  }

  /**
   * TTL backstop reap. Runs `gcShadowBranches`, which deletes
   * orphaned-branch WIP refs (24h grace) and CONSOLIDATES stale 30-day session
   * writers on active branches (lossless). Gated; no-ops if unconfigured
   * (`projectGitDir` absent) or no shadow exists.
   */
  async runReap(trigger: string): Promise<void> {
    if (isMaintenanceDisabled() || this.destroyed) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.reapInner(trigger);
    } finally {
      this.running = false;
    }
  }

  /** Reap work without the gate (caller holds it). */
  private async reapInner(trigger: string): Promise<void> {
    if (!this.deps.projectGitDir) return; // unconfigured — reap disabled
    const shadow = this.deps.getShadow();
    if (!shadow) return;

    const start = performance.now();
    try {
      await gcShadowBranches(
        shadow,
        this.deps.projectGitDir,
        undefined,
        this.deps.contentRoot ?? '.',
      );
      recordMaintenanceRun('reap', 'ok', performance.now() - start);
    } catch (e) {
      recordMaintenanceRun('reap', 'error', performance.now() - start);
      log.warn({ trigger, err: e }, '[shadow-maintenance] reap failed; retrying next trigger');
    }
  }

  /**
   * Auto-consolidation. Folds DEAD AGENT chains
   * — `agent-*` WIP refs with no live keepalive — into a single typed
   * `auto-consolidation` checkpoint via the saveVersion spine, then deletes the
   * folded refs (compare-and-delete in the spine, race-free here by construction
   * since a dead writer-id can never commit again). Live chains and
   * principal- / classified chains are never touched by this path.
   *
   * Gated, ≥ `CONSOLIDATION_MIN_SPACING_MS` apart, and only when ≥
   * `DEAD_CHAIN_THRESHOLD` dead agent chains exist. No-ops if the consolidation
   * deps (`getCurrentBranch` + `isWriterLive`) were not provided.
   */
  async consolidateDeadChains(trigger: string): Promise<ConsolidationResult> {
    if (isMaintenanceDisabled() || this.destroyed) {
      return { consolidated: false, skipped: 'disabled' };
    }
    if (this.running) return { consolidated: false, skipped: 'busy' };
    this.running = true;
    try {
      return await this.consolidateInner(trigger);
    } finally {
      this.running = false;
    }
  }

  /** Consolidation work without the gate (caller holds it). */
  private async consolidateInner(trigger: string): Promise<ConsolidationResult> {
    const { getCurrentBranch, isWriterLive } = this.deps;
    if (!getCurrentBranch || !isWriterLive) {
      return { consolidated: false, skipped: 'unconfigured' };
    }
    if (Date.now() - this.lastConsolidationAt < CONSOLIDATION_MIN_SPACING_MS) {
      return { consolidated: false, skipped: 'spacing' };
    }
    const shadow = this.deps.getShadow();
    if (!shadow) return { consolidated: false, skipped: 'no-shadow' };

    try {
      const branch = getCurrentBranch() ?? 'main';
      const dead = await this.findDeadAgentChains(shadow, branch, isWriterLive);
      if (dead.length < DEAD_CHAIN_THRESHOLD) {
        return { consolidated: false, skipped: 'below-threshold', deadChains: dead.length };
      }
      const widthBefore = await countWipRefs(shadow, branch);
      await saveVersion(shadow, this.deps.contentRoot ?? '', dead, branch, undefined, {
        checkpointKind: {
          foldedRefs: dead.length,
          trigger: consolidationTriggerLabel(trigger),
        },
        // Maintenance-class fold — use the long timeout so a large dead-chain
        // consolidation on a degraded repo isn't killed by the 30s op watchdog
        // (matches the gc + TTL-reap legs).
        timeoutMs: MAINTENANCE_GIT_TIMEOUT_MS,
      });
      // Spacing is consumed only AFTER a successful fold: a below-threshold run
      // returns above without touching it, and a throw from saveVersion skips
      // this line so the next trigger retries promptly rather than waiting out
      // the full spacing window.
      this.lastConsolidationAt = Date.now();
      const widthAfter = await countWipRefs(shadow, branch);
      recordConsolidation(consolidationTriggerLabel(trigger));
      log.info(
        { trigger, branch, foldedChains: dead.length, widthBefore, widthAfter },
        '[shadow-maintenance] auto-consolidation folded dead agent chains',
      );
      return { consolidated: true, deadChains: dead.length, widthBefore, widthAfter };
    } catch (e) {
      log.warn(
        { trigger, err: e },
        '[shadow-maintenance] consolidation failed; retrying next trigger',
      );
      return { consolidated: false, skipped: 'error' };
    }
  }

  /**
   * Dead agent WIP chains on `branch`: `agent-*` chains whose writer has no live
   * keepalive and whose tip is not a park commit. One `for-each-ref` via
   * the shared enumerator — no per-ref git process.
   */
  private async findDeadAgentChains(
    shadow: ShadowHandle,
    branch: string,
    isWriterLive: (writerId: string) => boolean,
  ): Promise<WriterIdentity[]> {
    const chains = await enumerateWipChains(shadow, branch);
    return chains
      .filter((c) => c.classification === 'agent' && !c.isPark && !isWriterLive(c.writerId))
      .map((c) => ({
        id: c.writerId,
        name: c.writerId,
        email: `${c.writerId}@openknowledge.local`,
      }));
  }

  /**
   * Run `git gc --auto` on the shadow repo under the dedicated long timeout.
   * Gated: skips (no-op) if maintenance is disabled, another op is running, or
   * no shadow repo exists. git only packs once loose objects exceed `gc.auto`
   * (512), so a small repo no-ops cleanly. A gc.log latch is detected, counted,
   * and surfaced; we never force past it (it self-expires and we retry).
   */
  async runGc(trigger: string): Promise<GcRunResult> {
    if (isMaintenanceDisabled()) return { ran: false, skipped: 'disabled' };
    if (this.destroyed) return { ran: false, skipped: 'no-shadow' };
    if (this.running) {
      recordMaintenanceRun('gc', 'skipped', 0);
      return { ran: false, skipped: 'busy' };
    }
    this.running = true;
    try {
      return await this.gcInner(trigger);
    } finally {
      this.running = false;
    }
  }

  /** gc work without the gate (caller holds it). */
  private async gcInner(trigger: string): Promise<GcRunResult> {
    const shadow = this.deps.getShadow();
    if (!shadow) return { ran: false, skipped: 'no-shadow' };

    const start = performance.now();
    try {
      const before = await countShadowObjects(shadow);
      const sg = shadowGit(shadow, { timeoutMs: MAINTENANCE_GIT_TIMEOUT_MS });
      await sg.raw('gc', '--auto');
      const after = await countShadowObjects(shadow);
      const latch = hasGcLogLatch(shadow);
      const durationMs = performance.now() - start;
      recordMaintenanceRun('gc', 'ok', durationMs);
      if (latch) {
        // Count only the absent→present transition so the metric measures
        // distinct latch episodes, not repeated observations of one persistent
        // latch (see `lastGcLatch`). The warning log fires every run regardless.
        if (!this.lastGcLatch) recordGcLatch();
        log.warn(
          { trigger, looseObjects: after.looseObjects },
          '[shadow-maintenance] gc.log latch present — auto-gc disabled until it self-expires (~1 day); retrying next trigger',
        );
      }
      this.lastGcLatch = latch;
      log.info(
        {
          trigger,
          looseBefore: before.looseObjects,
          looseAfter: after.looseObjects,
          packfiles: after.packfiles,
          durationMs: Math.round(durationMs),
        },
        '[shadow-maintenance] gc complete',
      );
      return {
        ran: true,
        looseBefore: before.looseObjects,
        looseAfter: after.looseObjects,
        packfilesAfter: after.packfiles,
        latch,
        durationMs,
      };
    } catch (e) {
      recordMaintenanceRun('gc', 'error', performance.now() - start);
      log.warn({ trigger, err: e }, '[shadow-maintenance] gc failed; retrying next trigger');
      return { ran: false, skipped: 'error' };
    }
  }
}

export function createMaintenanceCoordinator(
  deps: MaintenanceCoordinatorDeps,
): MaintenanceCoordinator {
  return new MaintenanceCoordinator(deps);
}
