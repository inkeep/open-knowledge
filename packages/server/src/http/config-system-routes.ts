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
  ready: Promise<void> | undefined;
  durabilityState: Pick<DocumentDurabilityState, 'getActiveBranch'>;
  serverInstanceId: string;
  getDiskAckSVs: (() => Record<string, string>) | undefined;
  getCollabClientCount: (() => number) | undefined;
  getConfigDiagnostics: (() => ConfigDiagnosticsReport) | undefined;
  acpRegistry: AcpRegistry | undefined;
  loadAcpCustomAgents: (() => Promise<CustomAgentEntry[]>) | undefined;
  acpHarnessAvailability: () => Promise<AcpHarnessAvailability>;
  isRoutePeerAdmitted: (remoteAddress: string | undefined) => boolean;
  isAllowedWorkspaceHostHeader: (host: string | undefined) => boolean;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getPrincipal: (() => Principal | null) | undefined;
  semanticSearch: Pick<SemanticSearchService, 'getStatus'> | undefined;
  readSemanticProviderConfig: (() => ResolvedSemanticConfig) | undefined;
  embeddingsSecretsFile: string | undefined;
  getFileIndex: () => ReadonlyMap<string, FileIndexEntry>;
  shadowRef: ShadowRef | undefined;
  getCurrentBranch: (() => string | null) | undefined;
  installedAgentsCache: Pick<ReturnType<typeof createInstalledAgentsProbe>, 'probeAll'>;
}

export interface ConfigSystemRoutes {
  paths: readonly string[];
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

  const handleServerInfo = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (ready) {
          await ready.catch((err: unknown) => {
            log.warn(
              { err, handler: 'server-info' },
              '[api] ready gate rejected — responding with current state',
            );
          });
        }
        const currentBranch = durabilityState.getActiveBranch();
        const currentDiskAckSVs = getDiskAckSVs?.();
        const boot = getBootTimings();
        const collabClients = getCollabClientCount?.();
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
    supported: z.boolean(),
    featured: z.boolean(),
    harness: z
      .object({
        cli: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi']),
        availability: z.enum(['present', 'not-found', 'unknown']),
        credentials: z.enum(['present', 'unknown']),
      })
      .optional(),
  });
  const AcpCatalogSuccessSchema = z.object({
    agents: z.array(AcpCatalogAgentSchema),
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
    if (!checkLocalOpSecurity(req, res, { handler: 'installed-agents' })) return;
    try {
      await handleInstalledAgents(req, res, installedAgentsCache.probeAll);
    } catch (e) {
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

  const lockDir = projectDir ? getLocalDir(projectDir) : null;
  async function handleApiConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const collabUrl = collabUrlFromRequestHeaders(req.headers);
        const port = lockDir ? (readServerLock(lockDir)?.port ?? 0) : 0;
        const payload = { collabUrl, previewUrl: null, port, singleFile: ephemeral };
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

  async function handleConfigDiagnostics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const payload = getConfigDiagnostics?.() ?? { diagnostics: [] };
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

  const handleSemanticStatus = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
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
        const keyHint = cred.apiKey && cred.apiKey.length >= 8 ? cred.apiKey.slice(-4) : null;
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

  const RESCUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const handleRescueList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!shadowRef?.current) {
          successResponse(res, 200, RescueListSuccessSchema, [], { handler: 'rescue-list' });
          return;
        }

        const now = Date.now();
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
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
