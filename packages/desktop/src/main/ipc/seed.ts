import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { getLogger } from '../desktop-logger.ts';

export type SeedPlanResult = OkSeedPlanResult;
export type SeedApplyResult = OkSeedApplyResult;
export type SeedListPacksResult = OkSeedListPacksResult;

interface SeedIpcDeps {
  resolveProjectRoot: () => string | undefined;
  planSeed?: typeof planSeedImpl;
  applySeed?: typeof applySeedImpl;
}

function noProjectError(): { ok: false; error: { kind: 'no-project'; message: string } } {
  return {
    ok: false,
    error: {
      kind: 'no-project',
      message: 'No project is bound to this window. Open a project first.',
    },
  };
}

function internalError(err: unknown): { ok: false; error: { kind: 'internal'; message: string } } {
  getLogger('ipc:seed').error({ err }, 'unexpected seed error');
  return {
    ok: false,
    error: { kind: 'internal', message: err instanceof Error ? err.message : String(err) },
  };
}

function normalizePreviewPlan(plan: ScaffoldPlan, skillsInstallable: boolean): ScaffoldPlan {
  const { packSkillHomeRefusal, ...rest } = plan;
  void packSkillHomeRefusal;
  if (rest.packSkills === undefined) return rest;
  return {
    ...rest,
    packSkills: rest.packSkills.map((skill) => ({ ...skill, pending: skillsInstallable })),
  };
}

export async function handleSeedPlan(
  deps: SeedIpcDeps,
  options?: SeedPlanOptions,
): Promise<SeedPlanResult> {
  const preview = options?.preview;
  const projectRoot = preview
    ? join(tmpdir(), `ok-seed-preview-${randomUUID()}`)
    : deps.resolveProjectRoot();
  if (!projectRoot) return noProjectError();

  const plan = deps.planSeed ?? planSeedImpl;
  const rawPackId = options?.packId;
  const packId: PackId | undefined = coercePackId(rawPackId);
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
      skipPrerequisite: preview !== undefined,
    });
    return {
      ok: true,
      plan: preview ? normalizePreviewPlan(result, preview.skillsInstallable === true) : result,
    };
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

export async function handleSeedListPacks(): Promise<SeedListPacksResult> {
  return { ok: true, packs: listStarterPacks() };
}
