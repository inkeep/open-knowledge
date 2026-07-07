/**
 * IPC handler implementations for the `ok seed` scaffolder.
 *
 * Exposes three channels to the renderer:
 *   - `ok:seed:plan`       — compute the ScaffoldPlan for the current project
 *   - `ok:seed:apply`      — apply a ScaffoldPlan returned by `ok:seed:plan`
 *   - `ok:seed:list-packs` — enumerate available starter packs
 *
 * Follows the same pure-injectable shape as `packages/desktop/src/main/ipc-handlers.ts`:
 * each function takes an explicit `deps` object + channel args and returns the
 * channel result. Registration (binding to `ipcMain.handle` via `createHandler`)
 * happens in `main/index.ts`.
 *
 * `plan` and `apply` accept an optional `packId`, threaded into the server seed
 * module. `list-packs` is a thin wrapper over `STARTER_PACKS` so the picker UI
 * fetches metadata once on mount.
 *
 * Rationale: logic lives in `@inkeep/open-knowledge-server`'s seed module.
 * The IPC layer is a thin wrapper that scopes the call to the current
 * window's project root — no business logic here.
 */

import {
  applySeed as applySeedImpl,
  coercePackId,
  listStarterPacks,
  type PackId,
  planSeed as planSeedImpl,
  type ScaffoldPlan,
  SeedPrerequisiteError,
  SeedRootDirError,
} from '@inkeep/open-knowledge-server';
import type {
  OkSeedApplyResult,
  OkSeedListPacksResult,
  OkSeedPlanResult,
  SeedApplyOptions,
  SeedPlanOptions,
} from '../../shared/bridge-contract.ts';

// Wire-format aliases — kept for compatibility with `ipc-channels.ts`.
export type SeedPlanResult = OkSeedPlanResult;
export type SeedApplyResult = OkSeedApplyResult;
export type SeedListPacksResult = OkSeedListPacksResult;

/** Injected by `main/index.ts`; `plan` / `apply` delegate to the server module. */
interface SeedIpcDeps {
  /**
   * Resolve the project root for the invoking BrowserWindow. Returns `undefined`
   * when no ProjectContext is bound (e.g. Navigator window, which never reaches
   * these handlers in practice). Handlers reject with a structured error in
   * that case.
   */
  resolveProjectRoot: () => string | undefined;
  /** Override for tests. Defaults to `planSeed` from the server package. */
  planSeed?: typeof planSeedImpl;
  /** Override for tests. Defaults to `applySeed` from the server package. */
  applySeed?: typeof applySeedImpl;
}

/** Build the structured no-project error consistently for both plan + apply. */
function noProjectError(): { ok: false; error: { kind: 'no-project'; message: string } } {
  return {
    ok: false,
    error: {
      kind: 'no-project',
      message: 'No project is bound to this window. Open a project first.',
    },
  };
}

/** Map an arbitrary error onto the structured `internal` error envelope. */
function internalError(err: unknown): { ok: false; error: { kind: 'internal'; message: string } } {
  return {
    ok: false,
    error: { kind: 'internal', message: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * `ok:seed:plan` handler — compute a ScaffoldPlan for the current window's
 * project. Pure read; never writes to disk. Optional `rootDir` (relative to
 * the project root) scopes the scaffold to a subfolder. Optional `packId`
 * selects which pack to scaffold (defaults to `'knowledge-base'`).
 */
export async function handleSeedPlan(
  deps: SeedIpcDeps,
  options?: SeedPlanOptions,
): Promise<SeedPlanResult> {
  const projectRoot = deps.resolveProjectRoot();
  if (!projectRoot) return noProjectError();

  const plan = deps.planSeed ?? planSeedImpl;
  const rawPackId = options?.packId;
  const packId: PackId | undefined = coercePackId(rawPackId);
  // Trust-boundary symmetry with CLI + HTTP: reject explicit-but-unknown
  // packId rather than silently fall back to the default.
  if (typeof rawPackId === 'string' && rawPackId.length > 0 && packId === undefined) {
    return {
      ok: false,
      error: { kind: 'internal', message: `Unknown packId "${rawPackId}".` },
    };
  }
  try {
    const result = await plan({
      projectDir: projectRoot,
      rootDir: options?.rootDir,
      packId,
    });
    return { ok: true, plan: result };
  } catch (err) {
    if (err instanceof SeedPrerequisiteError) {
      return { ok: false, error: { kind: 'prerequisite-missing', message: err.message } };
    }
    if (err instanceof SeedRootDirError) {
      return { ok: false, error: { kind: 'invalid-root', message: err.message } };
    }
    return internalError(err);
  }
}

/**
 * `ok:seed:apply` handler — apply a ScaffoldPlan (returned by
 * `handleSeedPlan`) to the current window's project. `packId` resolves the
 * template registry (so `apply` content matches the pack `plan` was computed
 * against).
 */
export async function handleSeedApply(
  deps: SeedIpcDeps,
  plan: ScaffoldPlan,
  options?: SeedApplyOptions,
): Promise<SeedApplyResult> {
  const projectRoot = deps.resolveProjectRoot();
  if (!projectRoot) return noProjectError();

  const apply = deps.applySeed ?? applySeedImpl;
  const rawPackId = options?.packId;
  const packId: PackId | undefined = coercePackId(rawPackId);
  // Trust-boundary symmetry with CLI + HTTP.
  if (typeof rawPackId === 'string' && rawPackId.length > 0 && packId === undefined) {
    return {
      ok: false,
      error: { kind: 'internal', message: `Unknown packId "${rawPackId}".` },
    };
  }
  try {
    const result = await apply(plan, { projectDir: projectRoot, packId });
    return { ok: true, result };
  } catch (err) {
    return internalError(err);
  }
}

/**
 * `ok:seed:list-packs` handler — enumerate available starter packs. Static
 * data (no project context required) — the picker UI fetches this once on
 * dialog mount so a server-side registry change is reflected without a
 * client deploy. Delegates to the shared `listStarterPacks()` so HTTP + IPC
 * return the same wire-format shape from one source.
 */
export async function handleSeedListPacks(): Promise<SeedListPacksResult> {
  return { ok: true, packs: listStarterPacks() };
}
