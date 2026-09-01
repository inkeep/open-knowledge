import { getLogger } from './logger.ts';
import { gcShadowBranches } from './shadow-branch-gc.ts';
import {
  type ConsolidationTriggerLabel,
  recordConsolidation,
  recordGcLatch,
  recordMaintenanceRun,
} from './shadow-maintenance-telemetry.ts';
import { shadowOpGateFor } from './shadow-op-gate.ts';
import type { ShadowHandle, WriterIdentity } from './shadow-repo.ts';
import {
  enumerateWipChains,
  MAINTENANCE_GIT_TIMEOUT_MS,
  saveVersion,
  shadowGit,
} from './shadow-repo.ts';
import { countShadowObjects, countWipRefs, hasGcLogLatch } from './shadow-repo-stats.ts';

const log = getLogger('shadow-maintenance');

const DEAD_CHAIN_THRESHOLD = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_DEAD_CHAIN_THRESHOLD;
  if (!raw) return 5;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

const CONSOLIDATION_MIN_SPACING_MS = (() => {
  const raw = process.env.OK_SHADOW_MAINTENANCE_CONSOLIDATION_SPACING_MS;
  if (!raw) return 10 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
})();

function isMaintenanceDisabled(): boolean {
  return process.env.OK_SHADOW_MAINTENANCE_DISABLED === '1';
}

function consolidationTriggerLabel(trigger: string): ConsolidationTriggerLabel {
  if (trigger === 'boot') return 'boot';
  if (trigger === 'session-close') return 'session-close';
  if (trigger === 'ttl') return 'ttl';
  return 'dead-chain';
}

type GcSkipReason = 'disabled' | 'busy' | 'no-shadow' | 'error';

export interface GcRunResult {
  ran: boolean;
  skipped?: GcSkipReason;
  looseBefore?: number;
  looseAfter?: number;
  packfilesAfter?: number;
  latch?: boolean;
  durationMs?: number;
}

export interface MaintenanceCoordinatorDeps {
  getShadow: () => ShadowHandle | null;
  getCurrentBranch?: () => string | null;
  contentRoot?: string;
  isWriterLive?: (writerId: string) => boolean;
  projectGitDir?: string;
}

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
  deadChains?: number;
  widthBefore?: number;
  widthAfter?: number;
}

export class MaintenanceCoordinator {
  private running = false;
  private destroyed = false;
  private flushCommitCounter = 0;
  private lastConsolidationAt = 0;
  private lastGcLatch = false;

  constructor(private readonly deps: MaintenanceCoordinatorDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  destroy(): void {
    this.destroyed = true;
  }

  noteFlushCommit(): void {
    if (isMaintenanceDisabled() || this.destroyed) return;
    this.flushCommitCounter += 1;
    if (this.flushCommitCounter >= FLUSH_GC_INTERVAL) {
      this.flushCommitCounter = 0;
      void this.runScheduledMaintenance('flush-counter');
    }
  }

  async runBootMaintenance(): Promise<void> {
    if (isMaintenanceDisabled() || this.destroyed) return;
    await this.runScheduledMaintenance('boot');
  }

  async onSessionClose(): Promise<void> {
    await this.runScheduledMaintenance('session-close');
  }

  private async runScheduledMaintenance(trigger: string): Promise<void> {
    if (isMaintenanceDisabled() || this.destroyed) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.consolidateInner(trigger);
      if (this.destroyed) return;
      await this.reapInner(trigger);
      if (this.destroyed) return;
      await this.gcInner(trigger);
    } finally {
      this.running = false;
    }
  }

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

  private async reapInner(trigger: string): Promise<void> {
    if (!this.deps.projectGitDir) return;
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
        timeoutMs: MAINTENANCE_GIT_TIMEOUT_MS,
      });
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

  private async gcInner(trigger: string): Promise<GcRunResult> {
    const shadow = this.deps.getShadow();
    if (!shadow) return { ran: false, skipped: 'no-shadow' };

    return shadowOpGateFor(shadow).withExclusive(() => this.gcRun(trigger, shadow));
  }

  private async gcRun(trigger: string, shadow: ShadowHandle): Promise<GcRunResult> {
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
