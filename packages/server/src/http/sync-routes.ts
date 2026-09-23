import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Principal } from '@inkeep/open-knowledge-core';
import {
  type ConflictEntryWire,
  SyncConflictContentSuccessSchema,
  SyncConflictsSuccessSchema,
  SyncResolveBlockingRequestSchema,
  SyncResolveBlockingSuccessSchema,
  SyncResolveConflictRequestSchema,
  SyncResolveConflictSuccessSchema,
  SyncStatusSchema,
  SyncTriggerRequestSchema,
  SyncTriggerSuccessSchema,
} from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import type { ConflictAuthority } from '../conflict-authority.ts';
import {
  ConflictMarkersInContentError,
  NoConflictTrackedError,
  RESOLUTION_OPTIONS,
} from '../conflict-errors.ts';
import type { Conflict, ResolveStrategy } from '../conflict-kinds.ts';
import { strategiesFor } from '../conflict-kinds.ts';
import { selectReconcileOurs } from '../conflict-resolution.ts';
import { isShareableOkArtifact } from '../content-filter.ts';
import { stripDocExtension } from '../doc-extensions.ts';
import { claimExternalChange, releaseExternalChangeClaim } from '../external-change-attribution.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { pathToDocName } from '../file-watcher.ts';
import { SymlinkEscapeError } from '../fs-safety.ts';
import type { PinoLogger } from '../logger.ts';
import { containsUnresolvedConflictBlock } from '../reconciliation.ts';
import { assertRealpathWithinDir } from '../symlink-guard.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { errnoCode } from './handler-utils.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

const RESOLVE_ATTRIBUTION_WINDOW_MS = 3_000;

export interface SyncRouteDeps {
  projectDir: string | undefined;
  contentDir: string;
  /** Server-side principal resolver — the only trusted actor source (precedent #24). */
  getPrincipal: (() => Principal | null) | undefined;
  hocuspocus: Hocuspocus;
  log: PinoLogger;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  conflicts: ConflictAuthority;
  serializeDoc: ((docName: string) => string | null) | undefined;
  setBatchInProgress: ((value: boolean) => void) | undefined;
}

export function createSyncRoutes(deps: SyncRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    contentDir,
    getPrincipal,
    hocuspocus,
    log,
    checkLocalOpSecurity,
    getSyncEngine,
    conflicts,
    serializeDoc,
    setBatchInProgress,
  } = deps;

  function wireEntry(entry: Conflict): ConflictEntryWire {
    const base = {
      file: entry.file,
      detectedAt: entry.detectedAt,
      conflict: entry.kind,
      docName: conflicts.docNameOf(entry),
      conflictKind:
        entry.kind === 'reconcile' && entry.reason === 'stale-external-write'
          ? ('stale-external-write' as const)
          : ('git' as const),
    };
    switch (entry.kind) {
      case 'merge-native':
        return base;
      case 'working-tree':
        return {
          ...base,
          theirsSha: entry.theirsSha,
          ...(entry.baseSha === undefined ? {} : { baseSha: entry.baseSha }),
        };
      case 'reconcile':
        return { ...base, reason: entry.reason };
      default: {
        const _exhaustive: never = entry;
        return base;
      }
    }
  }

  async function handleSyncStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-status' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-status',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      const engine = getSyncEngine?.();
      if (!engine) {
        successResponse(
          res,
          200,
          SyncStatusSchema,
          {
            state: 'dormant',
            lastSyncUtc: null,
            lastFetchUtc: null,
            lastPushedSha: null,
            ahead: 0,
            behind: 0,
            consecutiveFailures: 0,
            conflictCount: 0,
            hasRemote: false,
            syncEnabled: false,
            identityUnresolved: false,
            remote: null,
          },
          { handler: 'sync-status' },
        );
        return;
      }
      await engine.refreshRemote();
      successResponse(res, 200, SyncStatusSchema, engine.getStatus(), {
        handler: 'sync-status',
      });
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-status',
        cause: e,
      });
    }
  }

  const handleSyncTrigger = withValidation(
    SyncTriggerRequestSchema,
    async (_req, res, body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-trigger',
        });
        return;
      }
      const op = body.op ?? 'sync';
      successResponse(res, 202, SyncTriggerSuccessSchema, { op }, { handler: 'sync-trigger' });
      void engine.trigger(op).catch((err) => {
        log.error({ err, op }, '[sync] fire-and-forget trigger failed');
      });
    },
    {
      handler: 'sync-trigger',
      method: 'POST',
      preBodyGate: (req, res) => {
        if (!checkLocalOpSecurity(req, res, { handler: 'sync-trigger' })) return false;
        const engine = getSyncEngine?.();
        if (!engine) {
          errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
            handler: 'sync-trigger',
          });
          return false;
        }
        return true;
      },
    },
  );

  const handleSyncResolveBlocking = withValidation(
    SyncResolveBlockingRequestSchema,
    async (_req, res, _body) => {
      const engine = getSyncEngine?.();
      if (!engine) {
        errorResponse(res, 503, 'urn:ok:error:sync-not-active', 'Sync engine not active.', {
          handler: 'sync-resolve-blocking',
        });
        return;
      }
      if (engine.getBlockingPaths().length === 0) {
        errorResponse(
          res,
          409,
          'urn:ok:error:no-blocking-changes',
          'No local changes are blocking a merge.',
          {
            handler: 'sync-resolve-blocking',
          },
        );
        return;
      }
      try {
        const paths = engine.getBlockingPaths();
        const commitSha = await engine.commitBlockingPaths();
        successResponse(
          res,
          200,
          SyncResolveBlockingSuccessSchema,
          { action: 'commit', paths, ...(commitSha !== null ? { commitSha } : {}) },
          { handler: 'sync-resolve-blocking' },
        );
        void engine.trigger('sync').catch((err) => {
          log.error({ err }, '[sync] resolve-blocking follow-up sync failed');
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'sync-resolve-blocking',
          cause: e,
        });
      }
    },
    {
      handler: 'sync-resolve-blocking',
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: 'sync-resolve-blocking' }),
    },
  );

  async function handleSyncConflicts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflicts' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflicts',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    try {
      successResponse(
        res,
        200,
        SyncConflictsSuccessSchema,
        { conflicts: conflicts.list().map(wireEntry) },
        {
          handler: 'sync-conflicts',
        },
      );
    } catch (e) {
      errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
        handler: 'sync-conflicts',
        cause: e,
      });
    }
  }

  const handleSyncResolveConflict = withValidation(
    SyncResolveConflictRequestSchema,
    async (_req, res, body) => {
      const { file, strategy, content } = body;
      /**
       * `extractActorIdentity` is the mandated resolver for actor-attributed handlers
       * (precedent #24); body `principalId` is ignored by contract.
       */
      const actor = extractActorIdentity(body as unknown as Record<string, unknown>, getPrincipal);
      let claimedDocName: string | undefined;
      if (projectDir && (actor.kind === 'agent' || actor.kind === 'principal')) {
        claimedDocName = pathToDocName(resolve(projectDir, file), contentDir);
        claimExternalChange(
          claimedDocName,
          {
            writerId: actor.writerId,
            displayName: actor.displayName,
            colorSeed: actor.colorSeed,
          },
          Date.now(),
          RESOLVE_ATTRIBUTION_WINDOW_MS,
        );
      }
      setBatchInProgress?.(true);
      try {
        await conflicts.resolve(file, strategy as ResolveStrategy, content);
        successResponse(
          res,
          200,
          SyncResolveConflictSuccessSchema,
          {},
          {
            handler: 'sync-resolve-conflict',
          },
        );
      } catch (e) {
        if (claimedDocName) releaseExternalChangeClaim(claimedDocName);
        if (e instanceof SymlinkEscapeError) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
            handler: 'sync-resolve-conflict',
          });
          return;
        }
        if (e instanceof NoConflictTrackedError) {
          errorResponse(
            res,
            404,
            'urn:ok:error:no-conflict-tracked',
            'No conflict is tracked for this path.',
            {
              handler: 'sync-resolve-conflict',
              detail:
                'This file has no tracked conflict — it may have been resolved by another session, or the path may be stale. Re-read conflicts({ kind: "list" }) before retrying.',
              extensions: { file: e.file },
            },
          );
          return;
        }
        if (e instanceof ConflictMarkersInContentError) {
          const tracked = conflicts.findByFile(e.file);
          const resolutionOptions =
            tracked === undefined
              ? RESOLUTION_OPTIONS
              : strategiesFor(
                  tracked.kind,
                  tracked.kind === 'reconcile' ? tracked.reason : undefined,
                );
          const strategyNotOffered = e.refusal === 'strategy-not-offered';
          errorResponse(
            res,
            422,
            'urn:ok:error:unresolved-conflict-markers',
            strategyNotOffered
              ? 'Strategy not offered for this conflict.'
              : 'Resolution still contains conflict markers.',
            {
              handler: 'sync-resolve-conflict',
              detail: strategyNotOffered
                ? `Strategy "${strategy}" is not offered for this conflict. Pick one of the strategies listed in resolutionOptions.`
                : 'The submitted content still contains a `<<<<<<< … >>>>>>>` block. Resolve every region, or take one side wholesale with a strategy listed in resolutionOptions.',
              extensions: { file: e.file, refusal: e.refusal, resolutionOptions },
            },
          );
          return;
        }
        const detail = e instanceof Error ? e.message : undefined;
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to resolve conflict.',
          {
            handler: 'sync-resolve-conflict',
            cause: e,
            detail,
            extensions: { file, strategy },
          },
        );
      } finally {
        setBatchInProgress?.(false);
      }
    },
    {
      handler: 'sync-resolve-conflict',
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: 'sync-resolve-conflict' }),
    },
  );

  async function handleSyncConflictContent(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!checkLocalOpSecurity(req, res, { handler: 'sync-conflict-content' })) return;
    if (req.method !== 'GET') {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: 'sync-conflict-content',
        extraHeaders: { Allow: 'GET' },
      });
      return;
    }
    if (!projectDir) {
      errorResponse(
        res,
        503,
        'urn:ok:error:project-repo-not-configured',
        'Project repo not configured.',
        { handler: 'sync-conflict-content' },
      );
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const file = url.searchParams.get('file');
    if (!file) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Missing required query param: file.',
        {
          handler: 'sync-conflict-content',
        },
      );
      return;
    }
    if (file.includes('..') || file.startsWith('/')) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid file path.', {
        handler: 'sync-conflict-content',
      });
      return;
    }
    const entry = conflicts.findByFile(file);
    if (entry === undefined) {
      errorResponse(
        res,
        404,
        'urn:ok:error:no-conflict-tracked',
        'No conflict is tracked for this path.',
        {
          handler: 'sync-conflict-content',
          extensions: { file },
        },
      );
      return;
    }
    const reason = entry.kind === 'reconcile' ? entry.reason : undefined;
    const resolutionOptions = [...strategiesFor(entry.kind, reason)];
    const docName = conflicts.docNameOf(entry) ?? stripDocExtension(file);
    const loaded = hocuspocus.documents.get(docName);
    const respond = (payload: {
      base: string;
      ours: string;
      theirs: string;
      kind: 'both-modified' | 'delete-modify' | 'modify-delete';
    }): void => {
      successResponse(
        res,
        200,
        SyncConflictContentSuccessSchema,
        {
          file,
          ...payload,
          conflict: entry.kind,
          conflictKind:
            reason === 'stale-external-write'
              ? ('stale-external-write' as const)
              : ('git' as const),
          ...(reason === undefined ? {} : { reason }),
          resolutionOptions,
        },
        { handler: 'sync-conflict-content' },
      );
    };

    const source = url.searchParams.get('source');

    switch (entry.kind) {
      case 'reconcile': {
        const liveOurs = source === 'ytext' && serializeDoc ? serializeDoc(docName) : null;
        respond({
          base: entry.stages.base,
          ours: selectReconcileOurs(entry, liveOurs),
          theirs: entry.stages.theirs,
          kind: 'both-modified',
        });
        return;
      }

      case 'working-tree': {
        const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
        try {
          const readBlob = async (sha: string | undefined): Promise<string> => {
            if (!sha) return '';
            try {
              return await pg.raw(['cat-file', 'blob', sha]);
            } catch (err) {
              console.warn(
                JSON.stringify({
                  event: 'conflict-content-readblob-failed',
                  file,
                  detail: err instanceof Error ? err.message : String(err),
                  handler: 'sync-conflict-content',
                }),
              );
              throw err;
            }
          };
          const theirs = await readBlob(entry.theirsSha);
          const base = await readBlob(entry.baseSha);
          let ours = '';
          let oursPresent = false;
          if (loaded) {
            const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
            if (ytextOurs !== null) {
              ours = ytextOurs;
              oursPresent = true;
            }
          } else {
            assertRealpathWithinDir(join(projectDir, file), projectDir, {
              allowShareableOkArtifact: isShareableOkArtifact,
            });
            try {
              ours = readFileSync(join(projectDir, file), 'utf-8');
              oursPresent = true;
            } catch (err) {
              if (errnoCode(err) !== 'ENOENT') {
                console.warn(
                  JSON.stringify({
                    event: 'conflict-content-ours-read-failed',
                    file,
                    detail: err instanceof Error ? err.message : String(err),
                    handler: 'sync-conflict-content',
                  }),
                );
                throw err;
              }
              oursPresent = false;
            }
          }
          respond({
            base,
            ours,
            theirs,
            kind: !oursPresent
              ? 'delete-modify'
              : theirs.length === 0
                ? 'modify-delete'
                : 'both-modified',
          });
        } catch (e) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to read conflict content.',
            { handler: 'sync-conflict-content', cause: e },
          );
        }
        return;
      }

      case 'merge-native': {
        const pg = simpleGit({ baseDir: projectDir, timeout: { block: 15_000 } });
        type StageResult = { present: false } | { present: true; content: string };
        const showStage = async (stage: 1 | 2 | 3): Promise<StageResult> => {
          try {
            return { present: true, content: await pg.raw(['show', `:${stage}:${file}`]) };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isAbsent =
              /pathspec|did not match|exists on disk, but not in|is in the index, but not at stage/i.test(
                msg,
              );
            if (!isAbsent) {
              console.warn(
                JSON.stringify({
                  event: 'showstage-unexpected-error',
                  stage,
                  file,
                  detail: msg,
                  handler: 'sync-conflict-content',
                }),
              );
              throw err;
            }
            return { present: false };
          }
        };
        try {
          const [baseResult, oursResult, theirsResult] = await Promise.all([
            showStage(1),
            showStage(2),
            showStage(3),
          ]);
          const base = baseResult.present ? baseResult.content : '';
          const theirs = theirsResult.present ? theirsResult.content : '';
          const stageKind: 'both-modified' | 'delete-modify' | 'modify-delete' =
            oursResult.present && theirsResult.present
              ? 'both-modified'
              : !oursResult.present && theirsResult.present
                ? 'delete-modify'
                : oursResult.present && !theirsResult.present
                  ? 'modify-delete'
                  : 'both-modified';
          let ours = oursResult.present ? oursResult.content : '';
          if (source === 'ytext' && loaded !== undefined && stageKind !== 'delete-modify') {
            const ytextOurs = serializeDoc ? serializeDoc(docName) : null;
            if (ytextOurs !== null && !containsUnresolvedConflictBlock(ytextOurs)) {
              ours = ytextOurs;
            } else if (ytextOurs !== null) {
              console.warn(
                JSON.stringify({
                  event: 'ytext-conflict-marker-detected',
                  'doc.name': docName,
                  handler: 'sync-conflict-content',
                }),
              );
            }
          }
          respond({ base, ours, theirs, kind: stageKind });
        } catch (e) {
          errorResponse(
            res,
            500,
            'urn:ok:error:internal-server-error',
            'Failed to read conflict content.',
            {
              handler: 'sync-conflict-content',
              cause: e,
            },
          );
        }
        return;
      }

      default: {
        const _exhaustive: never = entry;
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read conflict content.',
          {
            handler: 'sync-conflict-content',
            cause: new Error(`unknown conflict kind: ${JSON.stringify(_exhaustive)}`),
          },
        );
        return;
      }
    }
  }

  const routes = {
    '/api/sync/status': handleSyncStatus,
    '/api/sync/trigger': handleSyncTrigger,
    '/api/sync/conflicts': handleSyncConflicts,
    '/api/sync/conflict-content': handleSyncConflictContent,
    '/api/sync/resolve-conflict': handleSyncResolveConflict,
    '/api/sync/resolve-blocking': handleSyncResolveBlocking,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, {
    mutating: ['/api/sync/trigger', '/api/sync/resolve-conflict', '/api/sync/resolve-blocking'],
  });
}
