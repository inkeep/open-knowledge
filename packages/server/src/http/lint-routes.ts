/**
 * The lint + audit read family — `lint/config`, `lint/frontmatter-schemas`,
 * `lint`, `lint/audit`, `audit` — the fifth natively-routed Wave 2 group. The
 * editor reads the effective lint config through `lint/config`; the Settings
 * GUI's write side (native `.markdownlint.*` rules) stays in the extension. Same
 * lift shape as `link-graph-routes.ts` / `metrics-routes.ts` /
 * `document-routes.ts` / `config-system-routes.ts`: what the handlers closed
 * over in the extension arrives as {@link LintRouteDeps}, the handler bodies
 * are unchanged, and the extension composes this group's table into its
 * `nativeApi` handle while the legacy dispatch record loses the paths in the
 * same change.
 *
 * The write-side lint routes (`lint/markdownlint-config`,
 * `lint/frontmatter-schema`, `lint/fix`) ride the legacy MUTATING_ROUTES gate
 * and stay in the extension; they share `unmatchedGlobProblems` and
 * `readAuditGeneration` (the config-epoch reader coupled to the lint-config CC1
 * emitter), which therefore arrive here as deps rather than moving. The
 * per-server audit cache + single-flight are read-only-owned, so they move into
 * this group.
 */

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
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import type { ContentFilter } from '../content-filter.ts';
import type { DerivedDocumentIndexApiPort } from '../derived-document-index.ts';
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
  /** The extension's docName safety predicate (path-traversal refusal). */
  isSafeDocName: (docName: string) => boolean;
  /** docName → traversal-confined content-relative file path (null on refusal). */
  resolveDocFilePath: (contentDir: string, docName: string) => string | null;
  /** Rejects absolute / traversing scope params before they reach the walker. */
  isValidRelativeContentPath: (path: string) => boolean;
  /** The extension's Show All Files walker (schema-file discovery consumes it). */
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
  /**
   * Zero-match `appliesTo` detection over the project doc list — shared with
   * the write-side lint handlers that stay in the extension.
   */
  unmatchedGlobProblems: (effective: LinterConfig) => string[];
  /**
   * The lint-config epoch + branch + local-target generation reader — coupled
   * to the extension's `signalLintConfigChanged` CC1 emitter, so it stays there
   * and arrives here as a dep.
   */
  readAuditGeneration: () => string;
}

export interface LintRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
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

  /**
   * Live CRDT source for a currently-loaded doc, else null. Lint reads must
   * see the same bytes the editor and `/api/lint/fix` operate on: the disk
   * file lags the CRDT behind the persistence debounce, and if a flush is
   * ever lost the two diverge durably — a disk-only audit then reports
   * problems the live doc no longer has and the Fix all sweep no-ops forever.
   * Unloaded docs have no live copy; disk is authoritative for them.
   */
  const liveLintSourceFor = (docRelPath: string): string | null => {
    const docName = docRelPath.replace(/\.(md|mdx)$/i, '');
    const doc = hocuspocus.documents.get(docName);
    return doc === undefined ? null : doc.getText('source').toString();
  };

  // One cache per server instance (not module-scoped): its keys carry contentDir,
  // but a per-server lifetime also means a restart starts cold, which is the
  // right blast radius for a disk-stamp-keyed cache.
  const auditCache = new AuditCache();
  /**
   * Audits in flight, keyed by scope + config fingerprint. Every window runs the
   * freshness triggers independently, and the Problems panel can refresh at the
   * same moment, so a single config change can ask for the same whole-project
   * walk several times over. Coalescing makes them one walk instead of N cold
   * ones that each finish too late to warm the others' cache.
   *
   * The walk yields to the event loop, so a request issued after a config
   * mutation or a branch switch IS parsed while an earlier walk is still
   * running and could attach to it. The fingerprint alone would not stop that:
   * it covers the BASE config, which never carries markdownlint `rules` (those
   * come from the native `.markdownlint.*` cascade) nor frontmatter-schema
   * bodies, and says nothing at all about which branch's content is on disk.
   * {@link readAuditGeneration} is what makes the key move, which is why it is
   * read here per request rather than captured once. The per-file cache keys on
   * the fully-resolved config and the file's disk stamp, so nothing is cached
   * under the wrong rules or the wrong branch's bytes either way.
   */
  const auditFlight = createSingleFlight<ValidationAuditResult>();

  function runCoalescedAudit(
    validators: readonly ProjectValidator[],
    targetPath: string | undefined,
    configFingerprint: string,
  ): Promise<ValidationAuditResult> {
    const key = `${configFingerprint} ${readAuditGeneration()} ${targetPath ?? ''}`;
    return auditFlight.run(key, () => runValidationAudit(validators, { targetPath })).promise;
  }

  /**
   * A superseded walk has no plane to report, so the caller gets a retryable
   * 409 rather than a stale or mixed one. The store-side effect is exactly the
   * effect of any failed audit — previous entries stand — and whichever change
   * superseded this walk has already broadcast its own CC1 channel
   * (`lint-config` for a config mutation, `branch-switched` for a switch), so
   * the corrective walk is scheduled without the caller doing anything.
   */
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
        // A `?doc=` is accepted (the editor passes the active doc) but the
        // effective config resolves per doc (cli2 cascade: nearest native
        // file on the doc→root walk governs); no `?doc=` → root-level.
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

  // Enumerate the project's `.ok/schemas/*.json` files (flat, top-level only)
  // as project-root-relative paths for the mapping picker. A missing dir is
  // an empty list, not an error; bounded so a pathological schemas dir can't
  // produce an unbounded response.
  const handleFrontmatterSchemasList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const root = resolve(projectDir ?? contentDir);
        // Two discovery sources: the flat tool-created `.ok/schemas/` scan,
        // plus a filtered content walk for the ecosystem `*.schema.json`
        // convention anywhere in the project. The walk deliberately does NOT
        // re-admit `.ok`: the scan above already covers `.ok/schemas/`, and
        // lifting ContentFilter's always-skip floor here would let this
        // surface enumerate the rest of OK's internal state to find schemas.
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
        // Absent when there is nothing to report, matching the schema's
        // documented contract and the three sibling lint emitters. `ran` is the
        // field that is always present; do not carry that rule across to this one.
        const lintWarnings = [...configWarnings, ...summarizeLintPluginFailures(result.failures)];
        successResponse(
          res,
          200,
          LintDocResultSchema,
          { ...result, ...(lintWarnings.length > 0 ? { warnings: lintWarnings } : {}) },
          { handler: 'lint' },
        );
      } catch (e) {
        if (e instanceof SymlinkEscapeError) {
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
        // Absolute paths and traversal must not reach the walker: an audit
        // response carries offending-text snippets, so an unchecked scope is
        // an arbitrary-directory read for any connected agent.
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

  // Unified validation audit: every registered project validator (markdownlint
  // walk + derived-index dead-link read) merged into one source-tagged plane.
  // Additive alongside /api/lint/audit and /api/dead-links, which keep their
  // single-validator contracts.
  const handleAudit = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const rawTarget = url.searchParams.get('path');
        let target = rawTarget === null || rawTarget === '' ? undefined : rawTarget;
        // Absolute paths and traversal must not reach the validators: the
        // lint walk reads file bytes under this scope, so an unchecked path
        // is an arbitrary-directory read for any connected caller.
        if (target !== undefined && !isValidRelativeContentPath(target)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid path.', {
            handler: 'audit',
          });
          return;
        }
        // `doc` scopes by docName (extension-less). The client freshness path
        // knows docNames from disk-ack frames, never file extensions, so the
        // extension resolution has to happen here. A doc indexed from a live
        // CRDT session may not be on disk yet — fall back to the default
        // extension so the links validator can still scope to it (mirrors the
        // links validator's own fallback).
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
        // `counts=1` tallies the same plane instead of enumerating it — the
        // freshness path behind file-tree tints wants per-file counts, and on a
        // large KB the enumerated bodies are tens of MB it discards on arrival.
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
    // `isMutating` tracks legacy MUTATING_ROUTES membership, not actual side
    // effects. Every route here is a read and none rode that gate; the
    // write-side lint routes (markdownlint-config / frontmatter-schema / fix)
    // stay in the extension on it.
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
