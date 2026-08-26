/**
 * The config + server-info read family — `config`, `config/diagnostics`,
 * `server-info`, `principal`, `workspace`, `semantic-status`, `acp/catalog`,
 * `installed-agents`, `__embed-detect`, `rescue` — the fourth natively-routed
 * Wave 2 group. Same lift shape as `link-graph-routes.ts` /
 * `metrics-routes.ts` / `document-routes.ts`: what the handlers closed over in
 * the extension arrives as {@link ConfigSystemRouteDeps}, the handler bodies
 * are unchanged, and the extension composes this group's table into its
 * `nativeApi` handle while the legacy dispatch record loses the paths in the
 * same change.
 *
 * `principal`, `workspace`, `installed-agents`, and `__embed-detect` carry
 * their loopback + Host / local-op gates INLINE, ahead of method dispatch (a
 * bad Host / peer must never learn the verb via 405). That contract is
 * different from the pipeline's `isMutating` mechanism, so these gates stay in
 * the handler bodies and `isMutating` stays false. The peer + Host predicates
 * arrive as deps because the extension widens them when the server is exposed.
 */

import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
import {
  ApiConfigSuccessSchema,
  type ConfigDiagnosticsReport,
  ConfigDiagnosticsReportSchema,
  DEFAULT_EMBEDDINGS_BASE_URL,
  EmbedDetectSuccessSchema,
  EmptyRequestSchema,
  isHiddenDocName,
  type Principal,
  PrincipalSuccessSchema,
  type RescueEntryFlat,
  type RescueEntryTimeline,
  RescueListSuccessSchema,
  SemanticIndexStatusSchema,
  ServerInfoSuccessSchema,
  WorkspaceSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import {
  ACP_AGENT_HARNESS_CLIS,
  type AcpHarnessAvailability,
} from '../acp/harness-availability.ts';
import {
  type AcpRegistry,
  type CustomAgentEntry,
  FEATURED_AGENT_IDS,
  registryPlatformKey,
} from '../acp/registry.ts';
import { MAX_ACP_THREADS } from '../acp/thread-manager.ts';
import { getBootTimings } from '../boot-timings.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { collabUrlFromRequestHeaders } from '../collab-bootstrap-url.ts';
import { getLocalDir } from '../config/paths.ts';
import { isSupportedDocFile, stripDocExtension } from '../doc-extensions.ts';
import type { DocumentDurabilityState } from '../document-durability-state.ts';
import { deriveDetection, embedProbeRing } from '../embed-probe.ts';
import {
  FileEmbeddingsBackend,
  type ResolvedSemanticConfig,
  resolveEmbeddingsCredential,
  type SemanticSearchService,
} from '../embeddings/index.ts';
import type { FileIndexEntry } from '../file-watcher.ts';
import { type createInstalledAgentsProbe, handleInstalledAgents } from '../handoff-api.ts';
import type { PinoLogger } from '../logger.ts';
import { readServerLock } from '../server-lock.ts';
import { listRescueCheckpoints, type ShadowRef, type TimelineRescueEntry } from '../shadow-repo.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { errnoCode } from './handler-utils.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface ConfigSystemRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  ephemeral: boolean;
  log: PinoLogger;
  /** Init-completion gate; server-info parks on it before serving branch state. */
  ready: Promise<void> | undefined;
  /** Only `getActiveBranch` is read (server-info); narrowed to it. */
  durabilityState: Pick<DocumentDurabilityState, 'getActiveBranch'>;
  serverInstanceId: string;
  getDiskAckSVs: (() => Record<string, string>) | undefined;
  getCollabClientCount: (() => number) | undefined;
  getConfigDiagnostics: (() => ConfigDiagnosticsReport) | undefined;
  acpRegistry: AcpRegistry | undefined;
  loadAcpCustomAgents: (() => Promise<CustomAgentEntry[]>) | undefined;
  acpHarnessAvailability: () => Promise<AcpHarnessAvailability>;
  /** Route-level peer gate (loopback always passes; `allowExternal` relaxes). */
  isRoutePeerAdmitted: (remoteAddress: string | undefined) => boolean;
  /**
   * The extension's exposure-widened workspace-Host predicate — when the
   * server is exposed, the tunnel's public Host passes alongside the loopback
   * names.
   */
  isAllowedWorkspaceHostHeader: (host: string | undefined) => boolean;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getPrincipal: (() => Principal | null) | undefined;
  /** Only `getStatus` is read (semantic-status); narrowed to it. */
  semanticSearch: Pick<SemanticSearchService, 'getStatus'> | undefined;
  readSemanticProviderConfig: (() => ResolvedSemanticConfig) | undefined;
  embeddingsSecretsFile: string | undefined;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  shadowRef: ShadowRef | undefined;
  getCurrentBranch: (() => string | null) | undefined;
  /** Only `probeAll` is read (installed-agents); narrowed to it. */
  installedAgentsCache: Pick<ReturnType<typeof createInstalledAgentsProbe>, 'probeAll'>;
}

export interface ConfigSystemRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
  table: ApiRouteTable;
}

export function createConfigSystemRoutes(deps: ConfigSystemRouteDeps): ConfigSystemRoutes {
  const {
    contentDir,
    projectDir,
    ephemeral,
    log,
    ready,
    durabilityState,
    serverInstanceId,
    getDiskAckSVs,
    getCollabClientCount,
    getConfigDiagnostics,
    acpRegistry,
    loadAcpCustomAgents,
    acpHarnessAvailability,
    isRoutePeerAdmitted,
    isAllowedWorkspaceHostHeader,
    checkLocalOpSecurity,
    getPrincipal,
    semanticSearch,
    readSemanticProviderConfig,
    embeddingsSecretsFile,
    getFileIndex,
    shadowRef,
    getCurrentBranch,
    installedAgentsCache,
  } = deps;

  /**
   * GET /api/server-info
   *
   * Returns `{ ok, serverInstanceId, currentBranch, currentDiskAckSVs }`.
   * Called by the client's `ProviderPool` as a boot-time warmup BEFORE
   * any WebSocket provider opens, so the first provider's auth token
   * can carry `expectedServerInstanceId` and `expectedBranch` on the
   * very first connect (avoiding one "null-claim accept → broadcast →
   * populate cache → next connect claim" cycle on cold start).
   *
   * `currentBranch` is the late-join backstop for CC1's `branch-switched`
   * stateless broadcast — disconnected clients reconnecting compare it
   * against their last-observed branch and trigger `handleBranchSwitched`
   * on mismatch (also surfaced as the `expectedBranch` auth-token claim,
   * see `auth-token-schema.ts`). Always populated — `getActiveBranch()`
   * defaults to `'main'` when git is disabled.
   *
   * Gated on `ready` for the same reason `handleDocumentList` is: the
   * boot-time `switchReconciledBaseScope(startupBranch)` lives inside
   * `initAsync` (server-factory.ts), and a renderer that fetches before
   * it runs would observe this server's initial `'main'` default instead of
   * the actual HEAD branch. The renderer's `current-branch-store` is
   * fire-once and only updates from CC1 `branch-switched`, so a stale
   * cold-start fetch sticks until a real cross-branch checkout.
   *
   * `currentDiskAckSVs` is the late-join backstop for the per-doc CC1
   * `disk-ack` channel — same recovery shape as `currentBranch` but the
   * per-doc state vector watermark used by mismatch-recycle baseline-
   * selection. Omitted in dev/plugin mode (no CC1 broadcaster).
   *
   * Gating: protected by the global `/api/*` Origin allowlist (CSRF
   * guard against cross-origin browsers). No-Origin requests (curl,
   * server-to-server, LAN peers using non-browser tooling) pass through
   * — the same posture as the rest of the read-side `/api/*` surface
   * (`/api/documents`, `/api/document`, `/api/pages`, `/api/backlinks`).
   * Disclosure shape: `serverInstanceId` is a per-process random UUID;
   * `currentBranch` matches the workspace's git history; the SV map
   * enumerates the same docName set as `/api/documents` plus per-
   * client Lamport op counts (random clientID, no wall-clock).
   * Single-user-loopback deployment model is documented in
   * `server-factory.ts` near the principalAuthExtension; hosted/multi-
   * tenant deployments must wrap this entire `/api/*` class with
   * authentication and per-caller scoping.
   */
  const handleServerInfo = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Park until `initAsync` has called `switchReconciledBaseScope` with
        // the resolved HEAD branch. Without this gate, a renderer that fetches
        // during the boot window reads this server's initial `'main'`
        // default and caches it in `current-branch-store` for the lifetime of
        // the session. Mirrors the `handleDocumentList` gate; `.catch()` keeps
        // the handler responsive on a degraded boot.
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'server-info' },
              '[api] ready gate rejected — responding with current state',
            );
          });
        }
        const currentBranch = durabilityState.getActiveBranch();
        // `getDiskAckSVs` is wired by standalone boot; plugin mode (dev
        // server) doesn't have a CC1Broadcaster and omits the field. The
        // schema's `.optional()` keeps the response shape valid in both
        // cases without a separate "no broadcaster" branch on the client.
        const currentDiskAckSVs = getDiskAckSVs?.();
        // Boot-phase timings (desktop startup instrumentation). Present only
        // when the boot path called `startBootTimings` (standalone `bootServer`);
        // the dev-server / plugin path leaves it `undefined`, so the schema's
        // `.optional()` keeps the response valid. All bounded numbers — safe to
        // disclose (per-process timing, no paths/content).
        const boot = getBootTimings();
        const collabClients = getCollabClientCount?.();
        // `Cache-Control: no-store` matches the disclosure semantics: every
        // field is per-process / per-moment state. A back/forward-cached
        // 304 carrying a stale `currentDiskAckSVs` could silently corrupt
        // the recycle baseline-selection on the next mismatch.
        successResponse(
          res,
          200,
          ServerInfoSuccessSchema,
          {
            serverInstanceId,
            currentBranch,
            ...(currentDiskAckSVs !== undefined ? { currentDiskAckSVs } : {}),
            ...(boot !== undefined ? { boot } : {}),
            ...(collabClients !== undefined ? { collabClients } : {}),
          },
          {
            handler: 'server-info',
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'server-info',
          cause: e,
        });
      }
    },
    { handler: 'server-info', method: 'GET', skipBodyParse: true },
  );

  const AcpCatalogAgentSchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    license: z.string().optional(),
    iconUrl: z.string().optional(),
    website: z.string().optional(),
    source: z.enum(['registry', 'custom']),
    /** A launchable distribution exists for this host platform. */
    supported: z.boolean(),
    featured: z.boolean(),
    harness: z
      .object({
        cli: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi']),
        availability: z.enum(['present', 'not-found', 'unknown']),
        /** No `absent` member — see `HarnessCredentials`. */
        credentials: z.enum(['present', 'unknown']),
      })
      .optional(),
  });
  const AcpCatalogSuccessSchema = z.object({
    agents: z.array(AcpCatalogAgentSchema),
    /** True when served from the offline fallback cache. */
    stale: z.boolean(),
    maxThreads: z.number(),
  });

  const handleAcpCatalog = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (acpRegistry === undefined) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'ACP catalog unavailable.', {
          handler: 'acp-catalog',
        });
        return;
      }
      try {
        const platform = registryPlatformKey();
        const { agents, stale } = await acpRegistry.getCatalog();
        const custom = (await loadAcpCustomAgents?.()) ?? [];
        const harnessAvailability = await acpHarnessAvailability();
        const rows = [
          ...agents.map((a) => {
            const harnessCli = ACP_AGENT_HARNESS_CLIS[a.id];
            return {
              id: a.id,
              name: a.name,
              version: a.version,
              ...(a.description !== undefined ? { description: a.description } : {}),
              ...(a.license !== undefined ? { license: a.license } : {}),
              ...(a.icon !== undefined ? { iconUrl: a.icon } : {}),
              ...(a.website !== undefined ? { website: a.website } : {}),
              source: 'registry' as const,
              supported:
                a.distribution.npx !== undefined ||
                a.distribution.uvx !== undefined ||
                (platform !== null && a.distribution.binary?.[platform] !== undefined),
              featured: FEATURED_AGENT_IDS.includes(a.id),
              ...(harnessCli !== undefined
                ? {
                    harness: {
                      cli: harnessCli,
                      availability: harnessAvailability[harnessCli]?.availability ?? 'unknown',
                      credentials: harnessAvailability[harnessCli]?.credentials ?? 'unknown',
                    },
                  }
                : {}),
            };
          }),
          ...custom.map((c: CustomAgentEntry) => ({
            id: c.id,
            name: c.name,
            version: 'custom',
            source: 'custom' as const,
            supported: true,
            featured: false,
          })),
        ];
        successResponse(
          res,
          200,
          AcpCatalogSuccessSchema,
          { agents: rows, stale, maxThreads: MAX_ACP_THREADS },
          { handler: 'acp-catalog', extraHeaders: { 'Cache-Control': 'no-store' } },
        );
      } catch (e) {
        errorResponse(
          res,
          502,
          'urn:ok:error:registry-unreachable',
          'Agent registry unreachable.',
          {
            handler: 'acp-catalog',
            cause: e,
          },
        );
      }
    },
    { handler: 'acp-catalog', method: 'GET', skipBodyParse: true },
  );

  async function handlePrincipal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback + Host-header gate. The principal record discloses operator
    // PII — `display_name` (real name) and `display_email` — sourced from
    // local `git config`. Under `--host 0.0.0.0` (demos, shared dev boxes,
    // Codespaces) this would otherwise be readable by any LAN peer or
    // cross-origin page that bypasses the Origin allowlist (non-browser
    // callers send no `Origin` header). Matches the same gate
    // `handleMetricsAgentPresence` and `handleWorkspace` apply.
    // Authorization runs BEFORE method dispatch so a bad Host never leaks
    // "verb the endpoint expects" via the 405 response (OWASP ASVS V4.1.1).
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'principal',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'principal',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'principal',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const principal = getPrincipal?.() ?? null;
    if (!principal) {
      errorResponse(res, 404, 'urn:ok:error:principal-not-available', 'Principal not available.', {
        handler: 'principal',
      });
      return;
    }
    successResponse(res, 200, PrincipalSuccessSchema, principal, { handler: 'principal' });
  }

  async function handleEmbedDetect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Diagnostic endpoint for the Cursor / Codex / Claude Code embedded-viewer
    // detection spikes. Reads from the in-process ring buffer populated in
    // `onRequest` and surfaces boolean signals derived from the most recent
    // entry's UA. Loopback + Host-header gated — same pattern as
    // `handlePrincipal` / `handleMetricsAgentPresence`. Disclosed fields
    // (full request headers, remote address) are local-editing-only signals.
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'embed-detect',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'embed-detect',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'embed-detect',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    const entries = embedProbeRing.read();
    successResponse(
      res,
      200,
      EmbedDetectSuccessSchema,
      {
        entries,
        count: entries.length,
        detection: deriveDetection(entries[0]),
      },
      { handler: 'embed-detect' },
    );
  }

  async function handleWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Authorization runs BEFORE method dispatch: reversing the order turns the
    // method check into a fingerprinting oracle for unauth callers (GET → 403,
    // POST → 405 discloses the verb the endpoint expects). See OWASP ASVS 4.0
    // V4.1.1 — "perform access control on every request."
    //
    // Loopback-only: this endpoint discloses the absolute host filesystem path
    // (including home directory / username). That's fine for the local-editing
    // use case the rest of the API is designed for, but if the user configures
    // `server.host: 0.0.0.0` (demos, shared dev boxes, Codespaces), we do NOT
    // want to leak the host shape over the network or to cross-origin fetches.
    // All loopback clients (including requests from a browser on the same
    // machine) pass — connections from other interfaces are refused.
    //
    // DNS-rebinding defense: `req.socket.remoteAddress` will read `127.0.0.1`
    // for any request that reached the socket via loopback, including requests
    // triggered by a malicious page that rebinds its hostname to `127.0.0.1`.
    // The Host-header allowlist below enforces that the caller actually spoke
    // to us via `localhost` / `127.0.0.1` / `[::1]`, matching the mitigation
    // in the Ethereum/geth JSON-RPC lineage. Same-origin fetches from the
    // editor app pass; cross-origin rebinding attempts are refused.
    if (!isRoutePeerAdmitted(req.socket.remoteAddress)) {
      errorResponse(res, 403, 'urn:ok:error:loopback-required', 'Loopback required.', {
        handler: 'workspace',
      });
      return;
    }
    if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
      errorResponse(res, 403, 'urn:ok:error:host-not-allowed', 'Host header not allowed.', {
        handler: 'workspace',
      });
      return;
    }
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'workspace',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    // Absolute, canonical contentDir so the client can build full filesystem
    // paths (e.g. for the sidebar 'Copy path > Full path' action). Symlinks in
    // the workspace root are resolved via realpath so the path matches on-disk
    // truth. We treat error kinds in line with the persistence layer's symlink
    // contract:
    //   - ENOENT: contentDir missing on disk → 200 with `symlinkResolved: false`
    //     and the unresolved path. Lets "Copy Path" still produce a meaningful
    //     value when the directory was deleted between server start and this
    //     request; the client decides whether to act on it.
    //   - ELOOP / EACCES / anything else: real filesystem error → 500. Matches
    //     persistence's stricter policy (cyclic symlinks are rejected
    //     everywhere) and avoids handing the user a path that won't resolve.
    const resolvedRoot = resolve(contentDir);
    let resolvedContentDir = resolvedRoot;
    let symlinkResolved = true;
    try {
      resolvedContentDir = realpathSync(resolvedRoot);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        log.warn(
          { path: resolvedRoot },
          '[workspace] contentDir does not exist; returning unresolved path',
        );
        symlinkResolved = false;
      } else {
        log.warn({ path: resolvedRoot, err }, '[workspace] realpath failed for contentDir');
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Workspace realpath failed.',
          { handler: 'workspace', detail: code ?? undefined, cause: err },
        );
        return;
      }
    }
    // `pathSeparator` lets the client build full paths without guessing from
    // the shape of `contentDir` (which breaks on Windows + forward-slash paths
    // and on POSIX folders that contain a literal backslash in the name).
    successResponse(
      res,
      200,
      WorkspaceSuccessSchema,
      {
        contentDir: resolvedContentDir,
        pathSeparator: sep,
        symlinkResolved,
      },
      { handler: 'workspace' },
    );
  }

  async function handleInstalledAgentsRoute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Loopback + DNS-rebinding gate. Same contract the rest of the host-
    // disclosure surface uses (`/api/workspace`, every `/api/local-op/*`) —
    // this endpoint discloses a stable OS-level fingerprint of which AI
    // agents are installed, readable without preflight under the permissive
    // `Access-Control-Allow-Origin: *` that `/api/*` sets. Gating on
    // `checkLocalOpSecurity` confines the fingerprint to same-machine,
    // same-origin callers (the editor UI) and refuses cross-origin browser
    // contexts + DNS-rebinding attempts that would otherwise succeed.
    // `checkLocalOpSecurity` itself emits RFC 9457 problem+json on rejection.
    if (!checkLocalOpSecurity(req, res, { handler: 'installed-agents' })) return;
    try {
      await handleInstalledAgents(req, res, installedAgentsCache.probeAll);
    } catch (e) {
      // Defensive: `handleInstalledAgents` catches internally, so this only
      // fires on truly unexpected throws (e.g., probeAll synchronously
      // throwing before its internal try/catch). Guard `headersSent` so we
      // don't double-emit if the inner handler already wrote a response.
      if (!res.headersSent) {
        log.error(
          { err: e, requestId: getRequestId(req) },
          '[installed-agents] route wrapper failed',
        );
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'installed-agents',
          cause: e,
        });
      }
    }
  }

  // `/api/config` — collab-bootstrap payload for the React shell. This server
  // serves the SPA itself, so the shell fetches `/api/config` from the same
  // origin (api-config.ts consumes it; the `--only ui` split-mode proxy in
  // `packages/cli` emits the same shape): GET returns
  // `{collabUrl, previewUrl, port}`. GET
  // stays open like the other read-only bootstrap endpoints
  // (document/pages/backlinks) — it carries no PII and only reflects the
  // client's own Host back to itself. `lockDir` is the project's
  // `.ok/local/` (the server-lock anchor); null when projectDir is unconfigured
  // (some test harnesses), leaving collabUrl bootstrap intact.
  const lockDir = projectDir ? getLocalDir(projectDir) : null;
  async function handleApiConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        // Same-origin collab WS: the shell loaded from this server, so
        // `ws(s)://<host>/collab` reaches the same process the request arrived
        // on (scheme honors X-Forwarded-Proto — see collab-bootstrap-url.ts).
        // Avoids the cross-port WS attempt sandboxed preview panes refuse. The
        // Host value is the client's own header reflected back to itself (the
        // Origin CORS gate in `onRequest` already refused cross-origin
        // browsers); it is not independently vetted here. A genuinely absent
        // Host yields a null collabUrl — a deliberate divergence from the
        // split-mode UI proxy's
        // `?? localhost:${resolvedPort}` fallback: this server has no single
        // canonical advertised port to substitute, and the client falls back
        // to a same-origin WS URL on a null. Node HTTP/1.1 always populates
        // Host, so the null path is a malformed-request floor, not a normal case.
        const collabUrl = collabUrlFromRequestHeaders(req.headers);
        const port = lockDir ? (readServerLock(lockDir)?.port ?? 0) : 0;
        // `singleFile` tells the React shell to drop project chrome for an
        // ephemeral single-file session (`ok <file>`).
        const payload = { collabUrl, previewUrl: null, port, singleFile: ephemeral };
        // HEAD carries the same headers but no body; `successResponse` always
        // writes a body, so the no-body verb stays a manual emit.
        if (req.method === 'HEAD') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.statusCode = 200;
          res.end();
          return;
        }
        successResponse(res, 200, ApiConfigSuccessSchema, payload, {
          handler: 'api-config',
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'api-config',
          cause: e,
        });
      }
      return;
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'api-config',
      extraHeaders: { Allow: 'GET, HEAD' },
    });
  }

  // `/api/config/diagnostics` — active config diagnostics across the user,
  // committed-project, and project-local layers. Read-only and open like
  // `/api/config`: the collector reads the files fresh per request (so a
  // hand-edit or `ok config migrate` is reflected without a restart) and
  // returns only structural findings — scope, file, key path, code, redirect —
  // never a raw config value. `no-store` so a poll always sees current disk
  // state.
  async function handleConfigDiagnostics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const payload = getConfigDiagnostics?.() ?? { diagnostics: [] };
        // HEAD mirrors GET's headers with no body; `successResponse` always
        // writes one, so the no-body verb stays a manual emit.
        if (req.method === 'HEAD') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.statusCode = 200;
          res.end();
          return;
        }
        successResponse(res, 200, ConfigDiagnosticsReportSchema, payload, {
          handler: 'api-config-diagnostics',
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'api-config-diagnostics',
          cause: e,
        });
      }
      return;
    }
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'api-config-diagnostics',
      extraHeaders: { Allow: 'GET, HEAD' },
    });
  }

  /**
   * GET /api/semantic-status — read-only setup/coverage probe for the Settings
   * UI. Reports the project-local `enabled` flag, `keyPresent` / `keySource`
   * (an API key is resolvable — a free file/env read), `ready` (has the service
   * warmed yet), `capable` (warmed AND a usable key found), and indexed coverage
   * (embedded / total embeddable pages). Side-effect-free: NO embed, NO egress,
   * NO warm (warming reads the key and — under the legacy keychain backend —
   * could prompt). Returns an inert all-false/zero shape when the service is
   * absent (dev/plugin mode).
   */
  const handleSemanticStatus = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Report the service's CURRENT known state — do NOT call ensureWarm()
        // (warming hydrates the cache; a read-only status GET shouldn't). `ready`
        // stays false until the first real search warms it.
        let enabled = false;
        let ready = false;
        let capable = false;
        let embedded = 0;
        if (semanticSearch) {
          const status = semanticSearch.getStatus();
          enabled = status.enabled;
          ready = status.ready;
          capable = status.capable;
          embedded = status.embeddedCount;
        }
        // Resolve the SAME credential the embedder would, for this project +
        // its configured endpoint, so status can't disagree with the real path.
        // A free, prompt-free file/env read — no warm, no egress. The key itself
        // is never returned; only `keyHint` (redacted last-4) so the UI can show
        // WHICH key is set. `keyNotRequired` marks a loopback endpoint that needs
        // no key at all, so the UI doesn't nag a keyless Ollama/LM Studio user.
        const statusConfig = readSemanticProviderConfig?.();
        const statusBaseUrl = statusConfig?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL;
        const cred = await resolveEmbeddingsCredential(
          new FileEmbeddingsBackend(embeddingsSecretsFile),
          projectDir ?? contentDir,
          statusBaseUrl,
        );
        const keyPresent = cred.apiKey !== null;
        const keyNotRequired = !keyPresent && cred.keyless;
        const keySource: 'project' | 'file' | 'env' | null = keyPresent
          ? (cred.source as 'project' | 'file' | 'env')
          : null;
        // Last 4 chars only, and only when the key is long enough that those 4 are
        // a negligible fraction (real provider keys are 40+ chars); never the key.
        const keyHint = cred.apiKey && cred.apiKey.length >= 8 ? cred.apiKey.slice(-4) : null;
        // Total embeddable pages = the same filtered set the search corpus uses.
        let total = 0;
        for (const [docName] of getFileIndex()) {
          if (!isSystemDoc(docName) && !isConfigDoc(docName) && !isHiddenDocName(docName)) {
            total += 1;
          }
        }
        successResponse(
          res,
          200,
          SemanticIndexStatusSchema,
          {
            enabled,
            keyPresent,
            keyNotRequired,
            keySource,
            keyHint,
            ready,
            capable,
            embedded,
            total,
          },
          { handler: 'semantic-status', extraHeaders: { 'Cache-Control': 'no-store' } },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'semantic-status',
          cause: e,
        });
      }
    },
    { handler: 'semantic-status', method: 'GET', skipBodyParse: true },
  );

  /** 24h in milliseconds — rescue buffers older than this are excluded/cleaned. */
  const RESCUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const handleRescueList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!shadowRef?.current) {
          // No shadow repo configured = no rescue buffers; emit empty list (success).
          successResponse(res, 200, RescueListSuccessSchema, [], { handler: 'rescue-list' });
          return;
        }

        const now = Date.now();
        // `source: 'flat'` rows came from the shutdown-flush path (retained flat-
        // file); `source: 'timeline'` rows came from reconcile-delete /
        // branch-switch (migrated to saveInMemoryCheckpoint). Clients
        // can treat both as interchangeable unless they need the checkpoint sha.
        const entries: (RescueEntryFlat | (RescueEntryTimeline & TimelineRescueEntry))[] = [];

        const rescueDir = resolve(shadowRef.current.gitDir, 'rescue');
        if (existsSync(rescueDir)) {
          try {
            const files = readdirSync(rescueDir).filter((f) => isSupportedDocFile(f));
            for (const file of files) {
              const filePath = resolve(rescueDir, file);
              const stat = statSync(filePath);
              const age = now - stat.mtimeMs;

              if (age > RESCUE_MAX_AGE_MS) {
                try {
                  unlinkSync(filePath);
                } catch (e) {
                  log.debug({ err: e }, '[rescue] cleanup failed (non-critical)');
                }
                continue;
              }

              entries.push({
                docName: stripDocExtension(file),
                timestamp: stat.mtime.toISOString(),
                size: stat.size,
                source: 'flat',
              });
            }
          } catch (err) {
            log.error({ err }, '[rescue] Failed to list flat-file rescue buffers');
          }
        }

        // Timeline-ref source — merged in so the unified response surfaces all
        // three rescue classes once the write migration ships.
        try {
          const branch = getCurrentBranch?.() ?? 'main';
          const timelineEntries = await listRescueCheckpoints(shadowRef.current, branch);
          for (const t of timelineEntries) {
            entries.push({ ...t, source: 'timeline' });
          }
        } catch (err) {
          log.error({ err }, '[rescue] Failed to list timeline-ref rescue checkpoints');
        }

        successResponse(res, 200, RescueListSuccessSchema, entries, { handler: 'rescue-list' });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'rescue-list',
          cause: e,
        });
      }
    },
    { handler: 'rescue-list', method: 'GET', skipBodyParse: true },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/config': handleApiConfig,
    '/api/config/diagnostics': handleConfigDiagnostics,
    '/api/server-info': handleServerInfo,
    '/api/principal': handlePrincipal,
    '/api/workspace': handleWorkspace,
    '/api/semantic-status': handleSemanticStatus,
    '/api/acp/catalog': handleAcpCatalog,
    '/api/installed-agents': handleInstalledAgentsRoute,
    '/api/__embed-detect': handleEmbedDetect,
    '/api/rescue': handleRescueList,
  };

  const table: ApiRouteTable = {
    resolve(url) {
      const handler = routes[url];
      if (handler) {
        return { template: url, dispatch: (req, res) => handler(req, res) };
      }
      return null;
    },
    // `isMutating` tracks legacy MUTATING_ROUTES membership, NOT actual side
    // effects: none of these paths were in that set at the merge base, so the
    // declaration is byte-faithful even though `GET /api/rescue` unlinks
    // rescue buffers older than 24h. The four gated endpoints (principal,
    // workspace, installed-agents, __embed-detect) enforce loopback + Host /
    // local-op INLINE, before method dispatch (gate-before-405) — a different
    // contract from the pipeline's mutating gate, so they do not migrate onto it.
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
