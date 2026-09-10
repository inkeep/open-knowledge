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
import type { AgentSessionManager } from '../agent-sessions.ts';
import { CONFIG_VALIDATION_REVERT_ORIGIN } from '../config-edit-origin.ts';
import type { ContentFilter } from '../content-filter.ts';
import { safeContentPath } from '../content-path.ts';
import type { DerivedDocumentIndexApiPort } from '../derived-document-index.ts';
import { canonicalDocName } from '../doc-extensions.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface TestRouteDeps {
  resetDocumentDurability: ((docName: string) => void) | undefined;
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
    resetDocumentDurability,
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
  const handleTestReset = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
        await sessionManager.closeAll(docName);
        hocuspocus.closeConnections(docName);
        const debounceId = `onStoreDocument-${docName}`;
        if (hocuspocus.debouncer.isDebounced(debounceId)) {
          await hocuspocus.debouncer.executeNow(debounceId);
        }
        const doc = hocuspocus.documents.get(docName);
        if (doc) await (forceUnloadDocument ?? hocuspocus.unloadDocument.bind(hocuspocus))(doc);
        resetDocumentDurability?.(docName);
        writeFileSync(filePath, '', 'utf-8');
        await derivedDocumentIndex?.testOnly?.resetDocumentForTest(docName);
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
        successResponse(res, 200, TestResetSuccessSchema, {}, { handler: 'test-reset' });
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
