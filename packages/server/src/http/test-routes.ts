import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import {
  CONFIG_DOC_NAME_OKIGNORE,
  EmptyRequestSchema,
  TestFlushGitSuccessSchema,
  TestRescanBacklinksSuccessSchema,
  TestRescanFilesSuccessSchema,
  TestResetSuccessSchema,
} from '@inkeep/open-knowledge-core';
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { CONFIG_VALIDATION_REVERT_ORIGIN } from '../config-edit-origin.ts';
import type { ConflictAuthority } from '../conflict-authority.ts';
import type { ContentFilter } from '../content-filter.ts';
import { safeContentPath } from '../content-path.ts';
import type { DerivedDocumentIndexApiPort } from '../derived-document-index.ts';
import { canonicalDocName } from '../doc-extensions.ts';
import type { DocumentDurabilityState } from '../document-durability-state.ts';
import type { RecentlyRemovedDocs } from '../recently-removed-docs.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

const TEST_RESET_SCOPES = ['document', 'server'] as const;
type TestResetScope = (typeof TEST_RESET_SCOPES)[number];

interface TestServerResetResidue {
  readonly loadedDocuments: readonly string[];
  readonly clientConnections: number;
  readonly agentSessions: number;
  readonly agentPresence: readonly string[];
  readonly staleExternalWrites: readonly string[];
  readonly removedDocuments: readonly string[];
}

function isTestResetScope(value: string): value is TestResetScope {
  return (TEST_RESET_SCOPES as readonly string[]).includes(value);
}

export interface TestRouteDeps {
  agentPresence: Pick<AgentPresenceBroadcaster, 'getPresenceMap' | 'clearPresence'> | undefined;
  resetSettingsForTest: (() => void) | undefined;
  settleDiskEvents: (() => Promise<void>) | undefined;
  recentlyRemovedDocs: Pick<RecentlyRemovedDocs, 'entries' | 'delete'> | undefined;
  conflicts: ConflictAuthority;
  durabilityState: DocumentDurabilityState;
  resolveAlias: (docName: string) => string;
  contentDir: string;
  log: import('../logger.ts').PinoLogger;
  sessionManager: AgentSessionManager;
  hocuspocus: Hocuspocus;
  forceUnloadDocument: ((document: Document) => Promise<void>) | undefined;
  derivedDocumentIndex: DerivedDocumentIndexApiPort | undefined;
  contentFilter: ContentFilter | undefined;
  bumpSkillsCatalogGen: () => void;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  flushGitCommit: (() => Promise<void>) | undefined;
  rescanFiles: (() => void | Promise<void>) | undefined;
}

export function createTestRoutes(deps: TestRouteDeps): ApiRouteGroup {
  const {
    agentPresence,
    resetSettingsForTest,
    settleDiskEvents,
    recentlyRemovedDocs,
    conflicts,
    durabilityState,
    resolveAlias,
    contentDir,
    log,
    sessionManager,
    hocuspocus,
    forceUnloadDocument,
    derivedDocumentIndex,
    contentFilter,
    bumpSkillsCatalogGen,
    signalChannel,
    flushGitCommit,
    rescanFiles,
  } = deps;
  async function unloadDocumentForTest(docName: string): Promise<void> {
    const debounceId = `onStoreDocument-${docName}`;
    if (hocuspocus.debouncer.isDebounced(debounceId)) {
      await hocuspocus.debouncer.executeNow(debounceId);
    }
    const doc = hocuspocus.documents.get(docName);
    if (doc) await (forceUnloadDocument ?? hocuspocus.unloadDocument.bind(hocuspocus))(doc);
    durabilityState.deleteReconciledBase(docName);
    conflicts.dissolveReconcile(docName);
  }

  function isServerStateDoc(docName: string): boolean {
    return isSystemDoc(docName) || isConfigDoc(docName);
  }

  async function resetLoadedState(keep: string): Promise<void> {
    for (const docName of hocuspocus.documents.keys()) {
      if (docName === keep || isServerStateDoc(docName)) continue;
      await unloadDocumentForTest(docName);
    }
    for (const agentId of Object.keys(agentPresence?.getPresenceMap() ?? {})) {
      agentPresence?.clearPresence(agentId);
    }
    for (const [docName] of recentlyRemovedDocs?.entries() ?? []) {
      recentlyRemovedDocs?.delete(docName);
    }
  }

  function residualServerState(): TestServerResetResidue {
    let clientConnections = 0;
    for (const document of hocuspocus.documents.values()) {
      clientConnections += document.getConnections().length;
    }
    return {
      loadedDocuments: [...hocuspocus.documents.keys()]
        .filter((docName) => !isServerStateDoc(docName))
        .sort(),
      clientConnections,
      agentSessions: sessionManager.liveSessionCount,
      agentPresence: Object.keys(agentPresence?.getPresenceMap() ?? {}).sort(),
      staleExternalWrites: durabilityState
        .listStaleExternalWrites()
        .map((conflict) => conflict.docName)
        .sort(),
      removedDocuments: (recentlyRemovedDocs?.entries() ?? []).map(([docName]) => docName).sort(),
    };
  }

  const handleTestReset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const scope = url.searchParams.get('scope') ?? 'document';
        if (!isTestResetScope(scope)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `scope must be one of ${TEST_RESET_SCOPES.join(', ')}.`,
            { handler: 'test-reset' },
          );
          return;
        }
        if (scope === 'server' && url.searchParams.has('reset-okignore')) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'reset-okignore cannot be combined with scope=server: a server-scope reset always restores .okignore.',
            { handler: 'test-reset' },
          );
          return;
        }
        if (scope === 'server' && resetSettingsForTest === undefined) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'scope=server needs a server started with an isolated config home.',
            { handler: 'test-reset' },
          );
          return;
        }
        const docName = canonicalDocName(
          resolveAlias(url.searchParams.get('docName') ?? 'test-doc'),
        );
        let filePath: string;
        try {
          filePath = safeContentPath(docName, contentDir);
        } catch (err) {
          log.error({ err, docName }, '[test-reset] safeContentPath rejected docName');
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid docName.', {
            handler: 'test-reset',
            cause: err,
          });
          return;
        }
        if (scope === 'server') {
          try {
            await settleDiskEvents?.();
          } catch (err) {
            errorResponse(
              res,
              500,
              'urn:ok:error:internal-server-error',
              'The server-scope reset did not run, because the file watcher could not settle.',
              {
                handler: 'test-reset',
                detail: err instanceof Error ? err.message : String(err),
                cause: err,
              },
            );
            return;
          }
        }
        await sessionManager.closeAll(scope === 'server' ? undefined : docName);
        hocuspocus.closeConnections(scope === 'server' ? undefined : docName);
        await unloadDocumentForTest(docName);
        writeFileSync(filePath, '', 'utf-8');
        await derivedDocumentIndex?.testOnly?.resetDocumentForTest(docName);
        if (scope === 'server') {
          await resetLoadedState(docName);
          resetSettingsForTest?.();
        }
        const resetOkignoreParam = url.searchParams.get('reset-okignore');
        const resetOkignore = resetOkignoreParam !== 'false';
        if (resetOkignore) {
          try {
            const okignorePath = resolve(contentDir, '.okignore');
            const okignoreDoc = hocuspocus.documents.get(CONFIG_DOC_NAME_OKIGNORE);
            if (okignoreDoc) {
              const ytext = okignoreDoc.getText('source');
              if (ytext.length > 0) {
                okignoreDoc.transact(() => {
                  ytext.delete(0, ytext.length);
                }, CONFIG_VALIDATION_REVERT_ORIGIN);
              }
            }
            if (existsSync(okignorePath)) {
              writeFileSync(okignorePath, '', 'utf-8');
            }
            if (contentFilter) {
              bumpSkillsCatalogGen();
              await contentFilter.rebuildIgnorePatterns();
            }
          } catch (err) {
            log.warn({ err }, '[test-reset] okignore reset partial failure');
          }
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          TestResetSuccessSchema,
          scope === 'server' ? { scope, residue: residualServerState() } : {},
          { handler: 'test-reset' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-reset',
          cause: e,
        });
      }
    },
    { handler: 'test-reset', method: 'POST', skipBodyParse: true },
  );

  const handleTestFlushGit = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        await flushGitCommit?.();
        successResponse(res, 200, TestFlushGitSuccessSchema, {}, { handler: 'test-flush-git' });
      } catch (e) {
        log.error({ err: e, requestId: getRequestId(_req) }, '[test-flush-git] flush failed');
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-flush-git',
          cause: e,
        });
      }
    },
    { handler: 'test-flush-git', method: 'POST', skipBodyParse: true },
  );

  const handleTestRescanBacklinks = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!derivedDocumentIndex?.testOnly) {
          errorResponse(
            res,
            503,
            'urn:ok:error:backlink-index-not-configured',
            'Backlink index is not configured.',
            { handler: 'test-rescan-backlinks' },
          );
          return;
        }
        await derivedDocumentIndex.testOnly.rescanBacklinksForTest();
        successResponse(
          res,
          200,
          TestRescanBacklinksSuccessSchema,
          {},
          { handler: 'test-rescan-backlinks' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-rescan-backlinks',
          cause: e,
        });
      }
    },
    { handler: 'test-rescan-backlinks', method: 'POST', skipBodyParse: true },
  );

  const handleTestRescanFiles = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        if (!rescanFiles) {
          errorResponse(
            res,
            503,
            'urn:ok:error:file-rescan-not-configured',
            'Watcher rescan capability is not configured.',
            { handler: 'test-rescan-files' },
          );
          return;
        }
        await rescanFiles();
        signalChannel?.('files');
        successResponse(
          res,
          200,
          TestRescanFilesSuccessSchema,
          {},
          { handler: 'test-rescan-files' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: 'test-rescan-files',
          cause: e,
        });
      }
    },
    { handler: 'test-rescan-files', method: 'POST', skipBodyParse: true },
  );
  return createApiRouteGroup(
    {
      '/api/test-reset': handleTestReset,
      '/api/test-flush-git': handleTestFlushGit,
      '/api/test-rescan-backlinks': handleTestRescanBacklinks,
      '/api/test-rescan-files': handleTestRescanFiles,
    },
    {
      mutating: [
        '/api/test-reset',
        '/api/test-flush-git',
        '/api/test-rescan-backlinks',
        '/api/test-rescan-files',
      ],
    },
  );
}
