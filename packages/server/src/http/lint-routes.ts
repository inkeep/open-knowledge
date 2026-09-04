import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  DEFAULT_LINTER_CONFIG,
  type DocumentListEntry,
  EmptyRequestSchema,
  FrontmatterSchemasListSuccessSchema,
  isFrontmatterSchemaAsset,
  type LinksValidationSetting,
  LintAuditResponseSchema,
  LintConfigResponseSchema,
  LintDocResultSchema,
  type LinterConfig,
  summarizeLintPluginFailures,
  ValidationAuditCountsResponseSchema,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from '../content-filter.ts';
import type { DerivedDocumentIndexApiPort } from '../derived-document-index.ts';
import { isContainmentRejection } from '../fs-safety.ts';
import { AuditSupersededError, auditProject, lintDoc } from '../lint/audit.ts';
import { AuditCache } from '../lint/audit-cache.ts';
import { listProjectSchemaFiles, SCHEMA_LIST_CAP } from '../lint/frontmatter-schemas.ts';
import {
  composeEffectiveLinterConfig,
  composeFrontmatterSchemasConfig,
  resolveNativeConfigForDoc,
} from '../lint/resolve-config.ts';
import {
  createProjectValidators,
  type ProjectValidator,
  runValidationAudit,
  toValidationCountsPlane,
  type ValidationAuditResult,
} from '../lint/validation-audit.ts';
import { createSingleFlight } from '../single-flight.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface LintRouteDeps {
  hocuspocus: Hocuspocus;
  contentDir: string;
  projectDir: string | undefined;
  contentFilter: ContentFilter | undefined;
  isSafeDocName: (docName: string) => boolean;
  resolveDocFilePath: (contentDir: string, docName: string) => string | null;
  isValidRelativeContentPath: (path: string) => boolean;
  streamShowAllEntries: (opts: {
    contentDir: string;
    contentFilter: ContentFilter;
    dirFilter: string | null;
    maxEntries: number;
  }) => AsyncGenerator<DocumentListEntry, { truncated: boolean }, void>;
  getLinterBaseConfig: (() => LinterConfig) | undefined;
  getLinksValidationSetting: (() => LinksValidationSetting) | undefined;
  derivedDocumentIndex: DerivedDocumentIndexApiPort | undefined;
  collectAdmittedDocNames: () => Promise<Set<string>>;
  unmatchedGlobProblems: (effective: LinterConfig) => string[];
  readAuditGeneration: () => string;
}

export interface LintRoutes {
  paths: readonly string[];
  table: ApiRouteTable;
}

export function createLintRoutes(deps: LintRouteDeps): LintRoutes {
  const {
    hocuspocus,
    contentDir,
    projectDir,
    contentFilter,
    isSafeDocName,
    resolveDocFilePath,
    isValidRelativeContentPath,
    streamShowAllEntries,
    getLinterBaseConfig,
    getLinksValidationSetting,
    derivedDocumentIndex,
    collectAdmittedDocNames,
    unmatchedGlobProblems,
    readAuditGeneration,
  } = deps;

  const liveLintSourceFor = (docRelPath: string): string | null => {
    const docName = docRelPath.replace(/\.(md|mdx)$/i, '');
    const doc = hocuspocus.documents.get(docName);
    return doc === undefined ? null : doc.getText('source').toString();
  };

  const auditCache = new AuditCache();
  const auditFlight = createSingleFlight<ValidationAuditResult>();

  function runCoalescedAudit(
    validators: readonly ProjectValidator[],
    targetPath: string | undefined,
    configFingerprint: string,
  ): Promise<ValidationAuditResult> {
    const key = `${configFingerprint} ${readAuditGeneration()} ${targetPath ?? ''}`;
    return auditFlight.run(key, () => runValidationAudit(validators, { targetPath })).promise;
  }

  function respondAuditSuperseded(res: ServerResponse, handler: string): void {
    errorResponse(
      res,
      409,
      'urn:ok:error:audit-superseded',
      'The lint configuration or branch changed while the audit was running; re-run it.',
      { handler },
    );
  }

  const handleGetLintConfig = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('doc');
        if (docName !== null && (docName === '' || !isSafeDocName(docName))) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid doc.', {
            handler: 'lint-config',
          });
          return;
        }
        const base = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configProblems: string[] = [];
        const native = resolveNativeConfigForDoc(contentDir, docName ?? undefined, (problem) =>
          configProblems.push(problem),
        );
        const effective = composeFrontmatterSchemasConfig(
          projectDir ?? contentDir,
          composeEffectiveLinterConfig(base, native),
          (problem) => configProblems.push(problem),
        );
        if (docName === null) configProblems.push(...unmatchedGlobProblems(effective));
        successResponse(
          res,
          200,
          LintConfigResponseSchema,
          { effective, configFile: native?.file ?? null, configProblems },
          { handler: 'lint-config' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to resolve lint config.',
          {
            handler: 'lint-config',
            cause: e,
          },
        );
      }
    },
    { handler: 'lint-config', method: 'GET', skipBodyParse: true },
  );

  const handleFrontmatterSchemasList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const root = resolve(projectDir ?? contentDir);
        const { schemas, truncated } = listProjectSchemaFiles(root);
        const found = new Set(schemas);
        let walkTruncated = false;
        if (contentFilter !== undefined) {
          const walk = streamShowAllEntries({
            contentDir,
            contentFilter,
            dirFilter: null,
            maxEntries: 20_000,
          });
          let walkResult = await walk.next();
          while (!walkResult.done) {
            const entry = walkResult.value;
            const entryPath = entry.kind === 'asset' ? entry.path : undefined;
            if (entryPath !== undefined && isFrontmatterSchemaAsset(entryPath)) {
              const projectRel = relative(root, resolve(contentDir, entryPath));
              if (!projectRel.startsWith('..') && !isAbsolute(projectRel)) found.add(projectRel);
            }
            walkResult = await walk.next();
          }
          walkTruncated = walkResult.value.truncated;
        }
        const merged = [...found].sort((a, b) => a.localeCompare(b));
        successResponse(
          res,
          200,
          FrontmatterSchemasListSuccessSchema,
          {
            schemas: merged.slice(0, SCHEMA_LIST_CAP),
            truncated: truncated || walkTruncated || merged.length > SCHEMA_LIST_CAP,
          },
          { handler: 'frontmatter-schemas-list' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to list frontmatter schemas.',
          { handler: 'frontmatter-schemas-list', cause: e },
        );
      }
    },
    { handler: 'frontmatter-schemas-list', method: 'GET', skipBodyParse: true },
  );

  const handleLintDoc = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const docName = url.searchParams.get('doc') ?? '';
        if (docName === '' || !isSafeDocName(docName)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing or invalid doc.', {
            handler: 'lint',
          });
          return;
        }
        const docRelPath = resolveDocFilePath(contentDir, docName);
        if (docRelPath === null) {
          errorResponse(res, 404, 'urn:ok:error:doc-not-found', 'Document not found.', {
            handler: 'lint',
          });
          return;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const configWarnings: string[] = [];
        const result = await lintDoc({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          docRelPath,
          onConfigProblem: (problem) => configWarnings.push(problem),
          liveSourceFor: liveLintSourceFor,
        });
        const lintWarnings = [...configWarnings, ...summarizeLintPluginFailures(result.failures)];
        successResponse(
          res,
          200,
          LintDocResultSchema,
          { ...result, ...(lintWarnings.length > 0 ? { warnings: lintWarnings } : {}) },
          { handler: 'lint' },
        );
      } catch (e) {
        if (isContainmentRejection(e)) {
          errorResponse(res, 400, 'urn:ok:error:path-escape', 'Path escape detected.', {
            handler: 'lint',
          });
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to lint document.', {
          handler: 'lint',
          cause: e,
        });
      }
    },
    { handler: 'lint', method: 'GET', skipBodyParse: true },
  );

  const handleLintAudit = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawTarget = url.searchParams.get('path');
        const target = rawTarget === null || rawTarget === '' ? undefined : rawTarget;
        if (target !== undefined && !isValidRelativeContentPath(target)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid path.', {
            handler: 'lint-audit',
          });
          return;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const result = await auditProject({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          targetPath: target,
          liveSourceFor: liveLintSourceFor,
          cache: auditCache,
          auditGeneration: readAuditGeneration,
        });
        successResponse(res, 200, LintAuditResponseSchema, result, { handler: 'lint-audit' });
      } catch (e) {
        if (e instanceof AuditSupersededError) {
          respondAuditSuperseded(res, 'lint-audit');
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to audit project.', {
          handler: 'lint-audit',
          cause: e,
        });
      }
    },
    { handler: 'lint-audit', method: 'GET', skipBodyParse: true },
  );

  const handleAudit = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawTarget = url.searchParams.get('path');
        let target = rawTarget === null || rawTarget === '' ? undefined : rawTarget;
        if (target !== undefined && !isValidRelativeContentPath(target)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid path.', {
            handler: 'audit',
          });
          return;
        }
        const rawDoc = url.searchParams.get('doc');
        const docParam = rawDoc === null || rawDoc === '' ? undefined : rawDoc;
        if (docParam !== undefined) {
          if (target !== undefined || !isValidRelativeContentPath(docParam)) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid doc.', {
              handler: 'audit',
            });
            return;
          }
          target = resolveDocFilePath(contentDir, docParam) ?? `${docParam}.md`;
        }
        const baseConfig = getLinterBaseConfig?.() ?? DEFAULT_LINTER_CONFIG;
        const validators = createProjectValidators({
          projectDir: projectDir ?? contentDir,
          contentDir,
          baseConfig,
          liveSourceFor: liveLintSourceFor,
          derivedDocumentIndex: derivedDocumentIndex ?? null,
          linksValidation: getLinksValidationSetting?.(),
          admittedDocNames: collectAdmittedDocNames,
          docFilePathFor: (docName) => resolveDocFilePath(contentDir, docName),
          cache: auditCache,
          auditGeneration: readAuditGeneration,
        });
        const result = await runCoalescedAudit(
          validators,
          target,
          AuditCache.fingerprintConfig(baseConfig),
        );
        if (url.searchParams.get('counts') === '1') {
          successResponse(
            res,
            200,
            ValidationAuditCountsResponseSchema,
            toValidationCountsPlane(result),
            { handler: 'audit' },
          );
          return;
        }
        successResponse(res, 200, ValidationAuditResponseSchema, result, { handler: 'audit' });
      } catch (e) {
        if (e instanceof AuditSupersededError) {
          respondAuditSuperseded(res, 'audit');
          return;
        }
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to audit project.', {
          handler: 'audit',
          cause: e,
        });
      }
    },
    { handler: 'audit', method: 'GET', skipBodyParse: true },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/lint/config': handleGetLintConfig,
    '/api/lint/frontmatter-schemas': handleFrontmatterSchemasList,
    '/api/lint': handleLintDoc,
    '/api/lint/audit': handleLintAudit,
    '/api/audit': handleAudit,
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
