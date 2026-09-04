type RenderProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

export interface RecoverableWebContents {
  readonly id: number;
  reload(): void;
  isDestroyed(): boolean;
}

export interface RenderProcessGoneDetails {
  reason: RenderProcessGoneReason;
  exitCode?: number;
}

interface RecoveryLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface RendererRecoveryDeps {
  now: () => number;
  logger: RecoveryLogger;
  defer: (fn: () => void) => void;
  promptManualRecovery: (contents: RecoverableWebContents, info: PromptInfo) => Promise<void>;
  loopWindowMs?: number;
  maxAutoReloads?: number;
  maxLifetimeAutoReloads?: number;
}

interface PromptInfo {
  reason: RenderProcessGoneReason;
  exitCode?: number;
  crashesInWindow: number;
  lifetimeAutoReloads: number;
  contentsId: number;
}

export interface RendererRecovery {
  handleRenderProcessGone(
    contents: RecoverableWebContents,
    details: RenderProcessGoneDetails,
  ): void;
  dispose(contents: RecoverableWebContents): void;
}

const RECOVERABLE_REASONS = new Set<RenderProcessGoneReason>([
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
]);

const ROUTINE_TEARDOWN_REASONS = new Set<RenderProcessGoneReason>(['clean-exit', 'killed']);

const DEFAULT_LOOP_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTO_RELOADS = 1;
const DEFAULT_MAX_LIFETIME_AUTO_RELOADS = 5;

interface PerContentsState {
  windowStartedAt: number;
  crashes: number;
  autoReloads: number;
  lifetimeAutoReloads: number;
  promptPending: boolean;
}

export function createRendererRecovery(deps: RendererRecoveryDeps): RendererRecovery {
  const states = new Map<RecoverableWebContents, PerContentsState>();
  const loopWindowMs = deps.loopWindowMs ?? DEFAULT_LOOP_WINDOW_MS;
  const maxAutoReloads = deps.maxAutoReloads ?? DEFAULT_MAX_AUTO_RELOADS;
  const maxLifetimeAutoReloads = deps.maxLifetimeAutoReloads ?? DEFAULT_MAX_LIFETIME_AUTO_RELOADS;

  return {
    handleRenderProcessGone(contents, details) {
      if (!RECOVERABLE_REASONS.has(details.reason)) {
        const leavesBlankWindow = !ROUTINE_TEARDOWN_REASONS.has(details.reason);
        const line = {
          event: 'renderer-recovery.ignored',
          reason: details.reason,
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          contentsId: contents.id,
        };
        const msg = 'renderer process gone for a reason recovery does not act on';
        if (leavesBlankWindow) deps.logger.warn(line, msg);
        else deps.logger.info(line, msg);
        return;
      }

      if (contents.isDestroyed()) {
        states.delete(contents);
        return;
      }

      const nowMs = deps.now();
      const prior = states.get(contents);
      const state: PerContentsState =
        prior === undefined || nowMs - prior.windowStartedAt > loopWindowMs
          ? {
              windowStartedAt: nowMs,
              crashes: 0,
              autoReloads: 0,
              lifetimeAutoReloads: prior?.lifetimeAutoReloads ?? 0,
              promptPending: prior?.promptPending ?? false,
            }
          : prior;
      state.crashes += 1;
      states.set(contents, state);

      const crashFields = {
        reason: details.reason,
        ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
        crashesInWindow: state.crashes,
        lifetimeAutoReloads: state.lifetimeAutoReloads,
        contentsId: contents.id,
      };

      if (state.promptPending) {
        deps.logger.info(
          { event: 'renderer-recovery.prompt-suppressed', ...crashFields },
          'recovery prompt is already open for this window',
        );
        return;
      }

      const windowBudgetSpent = state.autoReloads >= maxAutoReloads;
      const lifetimeBudgetSpent = state.lifetimeAutoReloads >= maxLifetimeAutoReloads;

      if (windowBudgetSpent || lifetimeBudgetSpent) {
        deps.logger.warn(
          {
            event: 'renderer-recovery.loop-detected',
            ...crashFields,
            exhausted: lifetimeBudgetSpent ? 'lifetime' : 'window',
          },
          'renderer died again after an automatic reload — asking the user instead of reloading',
        );
        state.promptPending = true;
        const clear = () => {
          const current = states.get(contents);
          if (current !== undefined) current.promptPending = false;
        };
        const clearAndLog = (err: unknown) => {
          clear();
          deps.logger.warn(
            { event: 'renderer-recovery.prompt-failed', ...crashFields, err },
            'recovery prompt rejected',
          );
        };
        try {
          deps.promptManualRecovery(contents, crashFields).then(clear, clearAndLog);
        } catch (err: unknown) {
          clear();
          deps.logger.warn(
            { event: 'renderer-recovery.prompt-failed', ...crashFields, err },
            'recovery prompt threw synchronously',
          );
        }
        return;
      }

      state.autoReloads += 1;
      state.lifetimeAutoReloads += 1;
      deps.logger.info(
        {
          event: 'renderer-recovery.reloading',
          ...crashFields,
          autoReloads: state.autoReloads,
          lifetimeAutoReloads: state.lifetimeAutoReloads,
        },
        'renderer died — reloading the window automatically',
      );
      /*
       * UPSTREAM(electron/electron#51900): the re-entrancy is fixed at or below
       * the pinned version, and this deferral deliberately outlives the fix —
       * the deferral window is observable contract (the reload-abandoned branch
       * below), so removing it is its own decision, not a version-bump effect.
       */
      deps.defer(() => {
        try {
          if (contents.isDestroyed()) {
            deps.logger.info(
              { event: 'renderer-recovery.reload-abandoned', ...crashFields },
              'window closed during the reload deferral — nothing left to reload',
            );
            return;
          }
          contents.reload();
        } catch (err: unknown) {
          deps.logger.warn(
            { event: 'renderer-recovery.reload-failed', ...crashFields, err },
            'renderer reload threw past the destroyed guard — window stays blank',
          );
        }
      });
    },
    dispose(contents) {
      states.delete(contents);
    },
  };
}
