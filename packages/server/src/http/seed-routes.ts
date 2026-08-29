/**
 * The `ok seed` scaffolder family — `seed/plan`, `seed/packs` (reads) plus
 * `seed/apply`, `seed/install-pack-skill` (mutating) — natively routed as one
 * group. What the handlers reach for arrives as {@link SeedRouteDeps}.
 *
 * All four handlers gate on `checkLocalOpSecurity` INLINE (the two reads run
 * it ahead of method dispatch; the two writers run it as a `preBodyGate`), so
 * the whole family is loopback-confined regardless of the table's mutating
 * declaration — `mutating` below reproduces the legacy `MUTATING_ROUTES`
 * membership (`seed/apply`, `seed/install-pack-skill`) so the pipeline-level
 * gate and its telemetry tag are unchanged across the lift.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SeedApplyRequestSchema,
  SeedApplySuccessSchema,
  SeedInstallPackSkillRequestSchema,
  SeedInstallPackSkillSuccessSchema,
  SeedListPacksSuccessSchema,
  SeedPlanSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  applySeed,
  coercePackId,
  installPackSkillOnDemand,
  listStarterPacks,
  planSeed,
  type ScaffoldPlan,
  SeedPrerequisiteError,
  SeedRootDirError,
} from '../seed/index.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SeedRouteDeps {
  contentDir: string;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export function createSeedRoutes(deps: SeedRouteDeps): ApiRouteGroup {
  const { contentDir, checkLocalOpSecurity } = deps;

  // ─── `ok seed` scaffolder endpoints ──────────────────────────────────────
  // GET /api/seed/plan  → 200 {plan} (RFC 9457 problem+json on error)
  // POST /api/seed/apply with { plan } → 200 {result} (RFC 9457 problem+json on error)
  //
  // Same `planSeed` / `applySeed` logic the CLI subcommand and Electron IPC
  // handler use. The IPC bridge (`ok:seed:plan` / `ok:seed:apply`) keeps its
  // in-process discriminated-union shape (`{ok: true, plan}` / `{ok: false,
  // error: {kind, message}}`); the HTTP fallback in `seedClient()` translates
  // RFC 9457 problem+json back to that shape at the renderer boundary so
  // `SeedDialog` / `EmptyEditorState` are transport-agnostic.
  // Gated on `checkLocalOpSecurity` because the operation mutates the local
  // filesystem; same contract as /api/local-op/* and /api/installed-agents.

  /**
   * GET `/api/seed/plan?rootDir=brain&packId=software-lifecycle` — preview the
   * scaffold for a given subfolder + pack. `rootDir` defaults to `.` (project
   * root). `packId` defaults to the registry default (`'knowledge-base'`) for
   * back-compat with single-scaffold callers; unknown ids coerce to undefined
   * and `resolvePack()` falls back to the default.
   *
   * Prerequisite-missing (no git init) → 422 with
   * `urn:ok:error:seed-prerequisite-missing`; invalid-root (escape segments,
   * absolute path) → 400 with `urn:ok:error:seed-invalid-root`. Both surface
   * a `detail` carrying the underlying message so renderers can echo it.
   */
  async function handleSeedPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'seed-plan' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'seed-plan',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rootDir = url.searchParams.get('rootDir') ?? undefined;
    const rawPackId = url.searchParams.get('packId');
    const packId = coercePackId(rawPackId);
    // Trust-boundary symmetry with the CLI: if the caller passed a `packId`
    // but it doesn't name a registered pack, reject explicitly rather than
    // silently fall back to the default pack (CLI returns "Unknown pack"
    // failure on the same input).
    if (rawPackId !== null && rawPackId !== '' && packId === undefined) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown packId.', {
        handler: 'seed-plan',
        detail: `Pack id "${rawPackId}" is not registered.`,
      });
      return;
    }
    try {
      const plan = await planSeed({ projectDir: contentDir, rootDir, packId });
      successResponse(res, 200, SeedPlanSuccessSchema, { plan }, { handler: 'seed-plan' });
    } catch (err) {
      if (err instanceof SeedPrerequisiteError) {
        errorResponse(
          res,
          422,
          'urn:ok:error:seed-prerequisite-missing',
          'Seed prerequisite missing.',
          { handler: 'seed-plan', cause: err },
        );
        return;
      }
      if (err instanceof SeedRootDirError) {
        // Fixed-vocabulary safe `detail` per RFC 9457 §3.1.5 — gives the
        // client an actionable message without leaking the rejected path
        // (raw err message goes through `cause` → Pino, never on wire).
        errorResponse(res, 400, 'urn:ok:error:seed-invalid-root', 'Invalid seed root directory.', {
          handler: 'seed-plan',
          detail: 'The provided root directory is not within the workspace content directory.',
          cause: err,
        });
        return;
      }
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'seed-plan',
        cause: err,
      });
    }
  }

  /**
   * `POST /api/seed/apply` — apply a pre-computed ScaffoldPlan to disk.
   * Body accepts `{plan, packId?}` (extras pass through
   * `SeedApplyRequestSchema.loose()`); `packId` defaults to the registry
   * default.
   */
  const handleSeedApply = withValidation(
    SeedApplyRequestSchema,
    async (_req, res, body) => {
      // SeedApplyRequestSchema accepts `plan: unknown` (forward-compat); reject
      // non-object payloads here so applySeed sees a structured value.
      const planValue = body.plan;
      if (!planValue || typeof planValue !== 'object') {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid plan payload.', {
          handler: 'seed-apply',
        });
        return;
      }
      const plan = planValue as ScaffoldPlan;
      // SeedApplyRequestSchema is `.loose()` so extras flow through as `unknown`
      // on the parsed body; coerce defensively at the trust boundary. If the
      // caller passed a non-empty `packId` that doesn't name a registered
      // pack, reject explicitly (trust-boundary symmetry with the CLI, which
      // returns an "Unknown pack" failure on the same input).
      const looseBody = body as { packId?: unknown };
      const rawPackId = looseBody.packId;
      const packId = coercePackId(rawPackId);
      if (typeof rawPackId === 'string' && rawPackId.length > 0 && packId === undefined) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown packId.', {
          handler: 'seed-apply',
          detail: `Pack id "${rawPackId}" is not registered.`,
        });
        return;
      }
      try {
        // The plan already has rootDir baked into its entries — apply only
        // needs projectDir + packId (so it knows which template registry to
        // resolve content from).
        const result = await applySeed(plan, { projectDir: contentDir, packId });
        successResponse(res, 200, SeedApplySuccessSchema, { result }, { handler: 'seed-apply' });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to apply seed plan.',
          {
            handler: 'seed-apply',
            cause: err,
          },
        );
      }
    },
    {
      handler: 'seed-apply',
      method: 'POST',
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'seed-apply' }),
    },
  );

  /**
   * `POST /api/seed/install-pack-skill` — install only a pack's companion
   * skills. It deliberately skips scaffold files and required-plugin changes:
   * the settings card is a separate user-owned install action, not a replay of
   * `ok seed` and not a side effect of the plugin toggle.
   */
  const handleSeedInstallPackSkill = withValidation(
    SeedInstallPackSkillRequestSchema,
    async (_req, res, body) => {
      const packId = coercePackId(body.packId);
      if (packId === undefined) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown packId.', {
          handler: 'seed-install-pack-skill',
          detail: `Pack id "${body.packId}" is not registered.`,
        });
        return;
      }
      try {
        const result = await installPackSkillOnDemand(contentDir, packId);
        successResponse(res, 200, SeedInstallPackSkillSuccessSchema, result, {
          handler: 'seed-install-pack-skill',
        });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to install pack skill.',
          { handler: 'seed-install-pack-skill', cause: err },
        );
      }
    },
    {
      handler: 'seed-install-pack-skill',
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: 'seed-install-pack-skill' }),
    },
  );

  /**
   * `GET /api/seed/packs` — enumerate available starter packs. Static data;
   * no project context required. The picker UI fetches once on dialog mount.
   * Delegates to the shared `listStarterPacks()` so HTTP + IPC return the
   * same wire-format shape from one source.
   */
  async function handleSeedPacks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'seed-packs' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'seed-packs',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    successResponse(
      res,
      200,
      SeedListPacksSuccessSchema,
      { packs: listStarterPacks() },
      { handler: 'seed-packs' },
    );
  }

  return createApiRouteGroup(
    {
      '/api/seed/plan': handleSeedPlan,
      '/api/seed/apply': handleSeedApply,
      '/api/seed/install-pack-skill': handleSeedInstallPackSkill,
      '/api/seed/packs': handleSeedPacks,
    },
    { mutating: ['/api/seed/apply', '/api/seed/install-pack-skill'] },
  );
}
