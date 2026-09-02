import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import type {
  OkPackId,
  OkScaffoldApplyResult,
  OkScaffoldPlan,
  OkSeedApplyResult,
  OkSeedError,
  OkSeedListPacksResult,
  OkSeedPackInfo,
  OkSeedPlanResult,
} from '@/lib/desktop-bridge-types';
import { emitSkillsChanged } from '@/lib/documents-events';

async function translateSeedError(res: Response): Promise<OkSeedError> {
  const body = (await res.json().catch(() => null)) as unknown;
  const parsed = ProblemDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'internal', message: `HTTP ${res.status}` };
  }
  const message = parsed.data.detail ?? parsed.data.title;
  const t = parsed.data.type;
  if (t === 'urn:ok:error:seed-prerequisite-missing') {
    return { kind: 'prerequisite-missing', message };
  }
  if (t === 'urn:ok:error:seed-invalid-root') {
    return { kind: 'invalid-root', message };
  }
  if (t === 'urn:ok:error:no-project-dir') {
    return { kind: 'no-project', message };
  }
  return { kind: 'internal', message };
}

interface SeedPlanOptions {
  rootDir?: string;
  packId?: OkPackId;
  preview?: { skillsInstallable: boolean };
}
interface SeedApplyOptions {
  packId?: OkPackId;
}

interface SeedClientShape {
  plan: (options?: SeedPlanOptions) => Promise<OkSeedPlanResult>;
  apply: (plan: OkScaffoldPlan, options?: SeedApplyOptions) => Promise<OkSeedApplyResult>;
  listPacks: () => Promise<OkSeedListPacksResult>;
}

export function seedClient(): SeedClientShape {
  const okDesktop = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (okDesktop?.seed) {
    const desktopApply = okDesktop.seed.apply;
    return {
      plan: okDesktop.seed.plan,
      apply: async (plan, options) => {
        const result = await desktopApply(plan, options);
        if (result.ok) emitSkillsChanged();
        return result;
      },
      listPacks: okDesktop.seed.listPacks,
    };
  }
  return {
    plan: async (options?: SeedPlanOptions): Promise<OkSeedPlanResult> => {
      const params = new URLSearchParams();
      if (options?.rootDir) params.set('rootDir', options.rootDir);
      if (options?.packId) params.set('packId', options.packId);
      const qs = params.toString();
      const res = await fetch(`/api/seed/plan${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        return { ok: false, error: await translateSeedError(res) };
      }
      const body = (await res.json().catch(() => null)) as { plan?: OkScaffoldPlan } | null;
      if (!body?.plan) {
        return { ok: false, error: { kind: 'internal', message: t`Malformed plan response` } };
      }
      return { ok: true, plan: body.plan };
    },
    apply: async (plan: OkScaffoldPlan, options?: SeedApplyOptions): Promise<OkSeedApplyResult> => {
      const res = await fetch('/api/seed/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          packId: options?.packId,
        }),
      });
      if (!res.ok) {
        return { ok: false, error: await translateSeedError(res) };
      }
      const body = (await res.json().catch(() => null)) as {
        result?: OkScaffoldApplyResult;
      } | null;
      if (!body?.result) {
        return { ok: false, error: { kind: 'internal', message: t`Malformed apply response` } };
      }
      emitSkillsChanged();
      return { ok: true, result: body.result };
    },
    listPacks: async (): Promise<OkSeedListPacksResult> => {
      const res = await fetch('/api/seed/packs');
      if (!res.ok) {
        return { ok: false, error: { kind: 'internal', message: `HTTP ${res.status}` } };
      }
      const body = (await res.json().catch(() => null)) as { packs?: OkSeedPackInfo[] } | null;
      if (!body || !Array.isArray(body.packs)) {
        return {
          ok: false,
          error: { kind: 'internal', message: t`Malformed listPacks response` },
        };
      }
      return { ok: true, packs: body.packs };
    },
  };
}
