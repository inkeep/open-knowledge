import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
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

/**
 * Translates an HTTP response carrying an RFC 9457 problem+json payload to
 * the in-process `OkSeedError` discriminated-union shape so the IPC and HTTP
 * transports surface identical types to renderers. Maps the cluster-H URN
 * tokens 1:1 to the `OkSeedError.kind` enum; everything else collapses to
 * `kind: 'internal'`.
 */
async function translateSeedError(res: Response): Promise<OkSeedError> {
  const body = (await res.json().catch(() => null)) as unknown;
  const parsed = ProblemDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: 'internal', message: `HTTP ${res.status}` };
  }
  const message = parsed.data.detail ?? parsed.data.title;
  // Subset-matching pattern: only seed-relevant URNs map to typed kinds; any
  // other ProblemType (the closed enum has 40+ tokens) intentionally falls
  // through to `internal`.
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

/**
 * Per-call options accepted by both transports. Declared locally rather than
 * imported because `desktop-bridge-types.ts` only re-exports the renderer-
 * facing types (`OkSeedPlanResult` etc.) — the option-bag aliases there are
 * private to the `window.okDesktop` declaration block. Keeping them inline
 * here means `seedClient()`'s explicit return type is self-contained and
 * doesn't TS4058 on unnameable external types.
 */
interface SeedPlanOptions {
  rootDir?: string;
  packId?: OkPackId;
}
interface SeedApplyOptions {
  packId?: OkPackId;
}

interface SeedClientShape {
  plan: (options?: SeedPlanOptions) => Promise<OkSeedPlanResult>;
  apply: (plan: OkScaffoldPlan, options?: SeedApplyOptions) => Promise<OkSeedApplyResult>;
  listPacks: () => Promise<OkSeedListPacksResult>;
}

/**
 * Runtime adapter that returns the right transport for plan/apply/list-packs —
 * Electron IPC when the desktop bridge is populated, otherwise HTTP fetch to
 * the Hocuspocus `/api/seed/*` endpoints. Either path hits the same underlying
 * functions in `@inkeep/open-knowledge-server`. The HTTP path emits flat
 * `{plan}` / `{result}` / `{packs}` on success and RFC 9457 problem+json on
 * error; this adapter translates either back to the in-process discriminated
 * union so all three transports surface identical types.
 */
export function seedClient(): SeedClientShape {
  const okDesktop = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (okDesktop?.seed) {
    const desktopApply = okDesktop.seed.apply;
    return {
      plan: okDesktop.seed.plan,
      // A starter pack installs its pack skill into `.ok/skills/`, so a mounted
      // Skills list (sidebar / Settings) must re-fetch — there's no file-watcher
      // signal for the skills library. Centralized here so every seed caller gets
      // it (IPC path).
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
        return { ok: false, error: { kind: 'internal', message: 'Malformed plan response' } };
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
        return { ok: false, error: { kind: 'internal', message: 'Malformed apply response' } };
      }
      // Pack skill landed in `.ok/skills/` — refresh any mounted Skills list.
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
          error: { kind: 'internal', message: 'Malformed listPacks response' },
        };
      }
      return { ok: true, packs: body.packs };
    },
  };
}
