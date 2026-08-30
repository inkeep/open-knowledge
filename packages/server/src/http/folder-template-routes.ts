/**
 * The folder-artifact family — `folder-config` (GET+PUT) plus the template
 * CRUD surface `template` (GET/PUT/POST/DELETE) and `template/import` —
 * natively routed as one group. Both families write `<folder>/.ok/*`
 * artifacts through the shared actor-attribution spine
 * (`attributeOkArtifactWrite` / `okArtifactKey` / `scheduleOkArtifactFlush`),
 * which is why they lift together. What the handlers reach for arrives as
 * {@link FolderTemplateRouteDeps}.
 *
 * All three paths are legacy `MUTATING_ROUTES` members (any-verb-mutates ⇒
 * every verb rides the mutating gate, GET arms included) — `mutating` below
 * reproduces that membership exactly.
 *
 * Templates are real CRDT content docs (`<folder>/.ok/templates/<name>`), so
 * the write handlers run the same conflict gate + paired-write + flush
 * machinery as the sibling content-write handlers; those spines stay in the
 * extension and arrive as deps.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { relative, resolve, sep } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  EmptyRequestSchema,
  FolderConfigGetSuccessSchema,
  FolderConfigPutRequestSchema,
  FolderConfigPutSuccessSchema,
  instantiateDoc,
  type Principal,
  parseTemplateFile,
  stripFrontmatter,
  TEMPLATE_NAME_REGEX,
  TemplateDeleteSuccessSchema,
  TemplateGetSuccessSchema,
  TemplateImportRequestSchema,
  TemplateImportSuccessSchema,
  TemplateMoveRequestSchema,
  TemplateMoveSuccessSchema,
  TemplatePutRequestSchema,
  TemplatePutSuccessSchema,
  templateContentDocName,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { composeAndWriteRawBody } from '../bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from '../cc1-broadcast.ts';
import { DocInConflictError, isDocInConflict, respondDocInConflict } from '../conflict-errors.ts';
import { enrichDirectory } from '../content/enrichment.ts';
import { applyFolderFrontmatterPatch } from '../content/folder-frontmatter-write.ts';
import {
  applyTemplateDelete,
  applyTemplateMove,
  applyTemplateWrite,
  composeTemplateContent,
  type TemplateFrontmatter,
} from '../content/templates-write.ts';
import type { StoreFailure } from '../document-durability-state.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import type { DiskEvent } from '../file-watcher.ts';
import { tracedUnlinkSync } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import { extractPageTitle } from '../page-identity.ts';
import type { RecentlyRemovedDocs } from '../recently-removed-docs.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { methodRouter } from './method-router.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface FolderTemplateRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  ephemeral: boolean;
  log: PinoLogger;
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  getPrincipal: (() => Principal | null) | undefined;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  recentlyRemovedDocs: RecentlyRemovedDocs | undefined;
  isSafeDocName: (docName: string) => boolean;
  resolveAlias: (docName: string) => string;
  resolveContentEntryPath: (contentDir: string, kind: 'file' | 'folder', path: string) => string;
  /** The extension's shared folder-path validator (also a history-group dep). */
  validateFolderRel: (
    raw: string,
    res: ServerResponse,
    label?: 'path' | 'folder',
    handler?: string,
  ) => { folderRel: string; resolvedContentDir: string } | null;
  /** Narrowed to the identity fields the template session open consumes. */
  extractAgentIdentity: (body: Record<string, unknown>) => {
    agentId: string;
    agentName: string;
    colorSeed: string;
    clientName: string | undefined;
  };
  extractActorIdentityFromQuery: (
    url: URL,
    principal: (() => Principal | null) | undefined,
  ) => ReturnType<typeof extractActorIdentity>;
  okArtifactKey: (
    kind: 'template' | 'folder-frontmatter' | 'folder' | 'skill',
    folder: string,
    name?: string,
  ) => string;
  attributeOkArtifactWrite: (
    actor: ReturnType<typeof extractActorIdentity>,
    artifactKey: string,
    subject: string,
    previousPaths?: Array<{ from: string; to: string }>,
  ) => void;
  scheduleOkArtifactFlush: (context: string) => void;
  flushDiskAndDetectOutcome: (
    docName: string,
  ) => Promise<{ kind: 'failure'; failure: StoreFailure } | { kind: 'divergence' } | null>;
  respondPersistenceFailure: (res: ServerResponse, failure: StoreFailure, handler: string) => void;
  respondDiskDivergence: (res: ServerResponse, handler: string) => void;
  registerWrittenDocInFileIndex: (docName: string, content: string) => void;
  captureAndCloseDocuments: (
    docNames: string[],
    lifecycleStatus: 'deleted-upstream' | 'renamed',
  ) => Promise<Map<string, string>>;
  renameTrackedPathInGit: (
    projectDir: string | undefined,
    sourcePath: string,
    destinationPath: string,
  ) => Promise<boolean>;
  renamePathOnDisk: (sourcePath: string, destinationPath: string) => void;
  /** Shared content-path splitter (module helper in the extension). */
  splitContentPath: (path: string) => { parent: string; basename: string };
  /** Post-write file-index mutator (absent when the watcher owns the index). */
  mutateFileIndex: ((event: DiskEvent) => void) | undefined;
}

export function createFolderTemplateRoutes(deps: FolderTemplateRouteDeps): ApiRouteGroup {
  const {
    contentDir,
    projectDir,
    ephemeral,
    log,
    hocuspocus,
    sessionManager,
    getPrincipal,
    signalChannel,
    getSyncEngine,
    recentlyRemovedDocs,
    isSafeDocName,
    resolveAlias,
    resolveContentEntryPath,
    validateFolderRel,
    extractAgentIdentity,
    extractActorIdentityFromQuery,
    okArtifactKey,
    attributeOkArtifactWrite,
    scheduleOkArtifactFlush,
    flushDiskAndDetectOutcome,
    respondPersistenceFailure,
    respondDiskDivergence,
    registerWrittenDocInFileIndex,
    captureAndCloseDocuments,
    renameTrackedPathInGit,
    renamePathOnDisk,
    splitContentPath,
    mutateFileIndex,
  } = deps;

  function validateTemplateName(name: string, res: ServerResponse, handler = 'template'): boolean {
    if (!name || !TEMPLATE_NAME_REGEX.test(name)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:invalid-request',
        'Invalid name: must be letters / digits / `_` / `-` only (no `.md` extension).',
        { handler },
      );
      return false;
    }
    return true;
  }

  /**
   * Resolve a template by walking leaf → root from `folderRel`, closest-wins.
   * Returns the matched file's abs path, the owning folder, and whether it's
   * `local` (owned by `folderRel` itself) or `inherited` (from an ancestor).
   * Single source of the resolution walk — shared by `handleTemplateGet` and
   * the move handler's inherited-vs-absent disambiguation.
   */
  function findTemplateLeafToRoot(
    resolvedContentDir: string,
    folderRel: string,
    name: string,
  ): { abs: string; folder: string; scope: 'local' | 'inherited' } | null {
    const segments = folderRel === '' ? [] : folderRel.split('/');
    for (let depth = segments.length; depth >= 0; depth--) {
      const ancestorFolder = depth === 0 ? '' : segments.slice(0, depth).join('/');
      const ancestorAbs =
        ancestorFolder === '' ? resolvedContentDir : resolve(resolvedContentDir, ancestorFolder);
      if (
        ancestorAbs !== resolvedContentDir &&
        !ancestorAbs.startsWith(`${resolvedContentDir}${sep}`)
      ) {
        continue;
      }
      const candidate = resolve(ancestorAbs, '.ok', 'templates', `${name}.md`);
      if (existsSync(candidate)) {
        return {
          abs: candidate,
          folder: ancestorFolder,
          scope: depth === segments.length ? 'local' : 'inherited',
        };
      }
    }
    return null;
  }

  function pickFrontmatterFields(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  /**
   * The CRDT doc name a template opens/persists under — its content-relative path
   * (`<folderRel>/.ok/templates/<name>`, ext-less, RAW). Delegates to the core
   * builder so server handlers, the client open path, and the properties panel
   * share one identity. `''` folder → `.ok/templates/<name>` (project root).
   */
  function templateDocNameFor(folderRel: string, name: string): string {
    return templateContentDocName(folderRel, name);
  }

  const handleFolderConfigGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const validated = validateFolderRel(
          url.searchParams.get('path') ?? '',
          res,
          'path',
          'folder-config-get',
        );
        if (!validated) return;
        const meta = await enrichDirectory(validated.folderRel, {
          projectDir: validated.resolvedContentDir,
        });
        const folderOkDir = resolve(validated.resolvedContentDir, validated.folderRel, '.ok');
        const localFmPath = resolve(folderOkDir, 'frontmatter.yml');
        let frontmatterLocal: Record<string, unknown> | null = null;
        if (existsSync(localFmPath)) {
          try {
            const raw = await readFile(localFmPath, 'utf-8');
            const parsed = parseYaml(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              frontmatterLocal = parsed as Record<string, unknown>;
            } else {
              frontmatterLocal = {};
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log.warn(
              { path: localFmPath, reason },
              `[folder-config:get] malformed YAML in ${localFmPath}: ${reason}`,
            );
            frontmatterLocal = null;
          }
        }

        // Folder frontmatter is SELF-ONLY (no ancestor cascade) and there
        // are no schema declarations — `frontmatter_local` is the folder's
        // own open-shape frontmatter, the whole contract.
        successResponse(
          res,
          200,
          FolderConfigGetSuccessSchema,
          {
            folder: meta,
            frontmatter_local: frontmatterLocal,
          },
          { handler: 'folder-config-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read folder config.',
          { handler: 'folder-config-get', cause: e },
        );
      }
    },
    { handler: 'folder-config-get', method: 'GET', skipBodyParse: true },
  );

  const handleFolderConfigPut = withValidation(
    FolderConfigPutRequestSchema,
    async (_req, res, body) => {
      try {
        // No-project single-file mode writes nothing into the user's directory
        // beyond the one edited doc. Folder config would land a
        // `<folder>/.ok/frontmatter.yml` sidecar in the user's tree — refuse.
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Folder configuration is not available in single-file mode.',
            { handler: 'folder-config-put' },
          );
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'folder-config-put',
          });
          return;
        }
        const validated = validateFolderRel(body.path, res, 'path', 'folder-config-put');
        if (!validated) return;

        // Write the folder's own frontmatter (open-shape, like a doc's) via the
        // single-folder merge-patch helper — addressed by the folder's own
        // path, no glob and no whitelist.
        const allApplied: Array<{ path: string; action: 'written' | 'deleted' | 'noop' }> = [];
        if (body.frontmatter !== undefined) {
          const result = applyFolderFrontmatterPatch({
            anchorDir: validated.resolvedContentDir,
            folderRel: validated.folderRel,
            patch: body.frontmatter,
          });
          if (!result.ok) {
            const status = result.error.code === 'WRITE_ERROR' ? 500 : 400;
            const urn =
              status === 500
                ? 'urn:ok:error:internal-server-error'
                : 'urn:ok:error:invalid-request';
            const title = status === 500 ? 'Failed to write folder config.' : result.error.message;
            errorResponse(res, status, urn, title, {
              handler: 'folder-config-put',
              detail: result.error.code,
              cause: new Error(result.error.message),
            });
            return;
          }
          allApplied.push({ path: result.path, action: result.action });
          // Attribute the frontmatter change (skip a no-op patch).
          if (result.action !== 'noop') {
            attributeOkArtifactWrite(
              actor,
              okArtifactKey('folder-frontmatter', validated.folderRel),
              `folder-frontmatter-${result.action === 'deleted' ? 'delete' : 'edit'}: ${result.path}`,
            );
            scheduleOkArtifactFlush('folder-config-put');
          }
        }

        successResponse(
          res,
          200,
          FolderConfigPutSuccessSchema,
          { applied: allApplied },
          { handler: 'folder-config-put' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to write folder config.',
          { handler: 'folder-config-put', cause: e },
        );
      }
    },
    { handler: 'folder-config-put', method: 'PUT' },
  );

  const handleFolderConfig = methodRouter(
    { GET: handleFolderConfigGet, PUT: handleFolderConfigPut },
    { handler: 'folder-config' },
  );

  /**
   * Conflict-aware refusal helper for the template handlers. A template is a
   * content doc now (`<folder>/.ok/templates/<name>`), so its live Y.Doc carries
   * a `lifecycle.status` Y.Map — a mutation against one mid-conflict must refuse
   * exactly like the sibling content-write handlers, whose paired-write path
   * (`composeAndWriteRawBody`) would otherwise clobber a doc the user is
   * mid-resolving. Takes the pre-resolved content doc name — same shape as the
   * sibling `checkSkillDocConflictGate`, so the two gates read as one pattern.
   * Returns `true` when the gate fired (caller short-circuits); `false` when
   * the mutation may proceed.
   */
  function checkTemplateConflictGate(
    templateDocName: string,
    handler: 'template-put' | 'template-delete' | 'template-move' | 'template-import',
    res: ServerResponse,
  ): boolean {
    const doc = hocuspocus.documents.get(templateDocName);
    if (doc && isDocInConflict(doc)) {
      respondDocInConflict(res, new DocInConflictError({ file: `${templateDocName}.md` }), handler);
      return true;
    }
    return false;
  }

  const handleTemplateGet = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateTemplateName(name, res, 'template-get')) return;

        // Walk leaf → root for closest match.
        const validated = validateFolderRel(
          url.searchParams.get('folder') ?? '',
          res,
          'folder',
          'template-get',
        );
        if (!validated) return;
        const { folderRel, resolvedContentDir } = validated;

        const found = findTemplateLeafToRoot(resolvedContentDir, folderRel, name);
        if (!found) {
          errorResponse(res, 404, 'urn:ok:error:template-not-found', 'Template not found.', {
            handler: 'template-get',
            detail: `Template "${name}" not found for folder "${folderRel || '.'}". Walked leaf → root.`,
          });
          return;
        }
        const { abs: foundAbs, folder: foundFolder, scope: foundScope } = found;

        const raw = await readFile(foundAbs, 'utf-8');
        // Normalize single-block (and legacy two-block) templates: wire
        // `frontmatter` = the template's identity (title/description), wire
        // `body` = the starter content (doc-frontmatter block + markdown) a
        // new doc receives. Tokens (`{{date}}`) are preserved verbatim.
        const model = parseTemplateFile(raw);
        const frontmatter = model.identity as Record<string, unknown>;
        const body = model.starterContent;

        const relPath = relative(resolvedContentDir, foundAbs)
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');

        successResponse(
          res,
          200,
          TemplateGetSuccessSchema,
          {
            template: {
              name,
              folder: foundFolder,
              scope: foundScope,
              path: relPath,
              frontmatter,
              body,
            },
          },
          { handler: 'template-get' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read template.', {
          handler: 'template-get',
          cause: e,
        });
      }
    },
    { handler: 'template-get', method: 'GET', skipBodyParse: true },
  );

  const handleTemplatePut = withValidation(
    TemplatePutRequestSchema,
    async (_req, res, body) => {
      try {
        // Templates write `<folder>/.ok/templates/*.md` into the content tree —
        // a user-dir artifact single-file mode must never create.
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Templates are not available in single-file mode.',
            { handler: 'template-put' },
          );
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-put',
          });
          return;
        }
        const name = body.name;
        if (!validateTemplateName(name, res, 'template-put')) return;
        const validated = validateFolderRel(body.folder, res, 'folder', 'template-put');
        if (!validated) return;

        // Conflict-aware refusal. See `checkTemplateConflictGate`.
        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-put',
            res,
          )
        )
          return;

        // Compose + validate the `.md` bytes server-side, then route the body
        // through the template's CRDT doc (precedent #24 / #38) — same shape as
        // skill-put. Templates are content docs, so the ordinary content
        // persistence path (not the managed-artifact branch) writes the file.
        const composed = composeTemplateContent({
          name,
          body: typeof body.body === 'string' ? body.body : '',
          frontmatter: pickFrontmatterFields(body.frontmatter) satisfies TemplateFrontmatter,
        });
        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid template request.', {
            handler: 'template-put',
            detail: composed.error.code,
            cause: new Error(composed.error.message),
          });
          return;
        }

        const templateFilePath = resolve(
          validated.resolvedContentDir,
          validated.folderRel,
          '.ok',
          'templates',
          `${name}.md`,
        );
        const templateCreated = !existsSync(templateFilePath);
        const templateRelPath = relative(validated.resolvedContentDir, templateFilePath)
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');
        const templateDocName = templateDocNameFor(validated.folderRel, name);

        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const templateSession = await sessionManager.getSession(templateDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        templateSession.dc.document.transact(() => {
          composeAndWriteRawBody(templateSession.dc.document, composed.content, 'agent');
        }, templateSession.origin);

        const templateFlush = await flushDiskAndDetectOutcome(templateDocName);
        if (templateFlush?.kind === 'failure') {
          respondPersistenceFailure(res, templateFlush.failure, 'template-put');
          return;
        }
        if (templateFlush?.kind === 'divergence') {
          respondDiskDivergence(res, 'template-put');
          return;
        }

        // Close the dropped-FSEvent gap at the source (see helper): the flush
        // may have just created this folder's `.ok/templates/` dir — exactly
        // the brand-new-subdir race where the watcher's create event can be
        // lost. Same net as the sibling agent-write handlers.
        registerWrittenDocInFileIndex(templateDocName, composed.content);

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', validated.folderRel, name),
          `${templateCreated ? 'template-create' : 'template-edit'}: ${templateRelPath}`,
        );
        scheduleOkArtifactFlush('template-put');
        successResponse(
          res,
          200,
          TemplatePutSuccessSchema,
          {
            path: templateRelPath,
            created: templateCreated,
            warnings: composed.warnings,
          },
          { handler: 'template-put' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to write template.', {
          handler: 'template-put',
          cause: e,
        });
      }
    },
    { handler: 'template-put', method: 'PUT' },
  );

  const handleTemplateDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = url.searchParams.get('name') ?? '';
        if (!validateTemplateName(name, res, 'template-delete')) return;
        const validated = validateFolderRel(
          url.searchParams.get('folder') ?? '',
          res,
          'folder',
          'template-delete',
        );
        if (!validated) return;

        // DELETE has no body (query-param transport); read identity + summary
        // from the query string into a synthetic body for extractActorIdentity.
        const actor = extractActorIdentityFromQuery(url, getPrincipal);
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-delete',
          });
          return;
        }

        // Conflict-aware refusal. See `checkTemplateConflictGate`.
        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-delete',
            res,
          )
        )
          return;

        // Tear down the live template content doc (if open) BEFORE removing the
        // file, so its debounced content store can't re-store (resurrect) it on
        // a later unload. Same spine doc-delete + skill-delete use; no-op when
        // the doc was never opened.
        await captureAndCloseDocuments(
          [templateDocNameFor(validated.folderRel, name)],
          'deleted-upstream',
        );

        const deleteInput: Parameters<typeof applyTemplateDelete>[0] = {
          projectDir: validated.resolvedContentDir,
          folder: validated.folderRel,
          name,
        };
        const result = applyTemplateDelete(deleteInput);
        if (!result.ok) {
          const status =
            result.error.code === 'WRITE_ERROR' ||
            result.error.code === 'UNLINK_FAILED' ||
            result.error.code === 'BAD_PROJECT_DIR'
              ? 500
              : 400;
          const urn =
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request';
          const title = status === 500 ? 'Failed to delete template.' : 'Invalid template request.';
          errorResponse(res, status, urn, title, {
            handler: 'template-delete',
            detail: result.error.code,
            cause: new Error(result.error.message),
          });
          return;
        }
        // Only attribute when a file was actually removed (no-op delete of an
        // absent template records nothing).
        if (result.existed) {
          attributeOkArtifactWrite(
            actor,
            okArtifactKey('template', validated.folderRel, name),
            `template-delete: ${result.path}`,
          );
          scheduleOkArtifactFlush('template-delete');
          // Mark the content doc removed so a stale tab redirects instead of
          // offering to resurrect it (parity with ordinary doc deletion).
          recentlyRemovedDocs?.setDeleted(templateDocNameFor(validated.folderRel, name));
        }
        successResponse(
          res,
          200,
          TemplateDeleteSuccessSchema,
          { existed: result.existed, path: result.path },
          { handler: 'template-delete' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to delete template.',
          { handler: 'template-delete', cause: e },
        );
      }
    },
    { handler: 'template-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleTemplateMove = withValidation(
    TemplateMoveRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-move',
          });
          return;
        }
        if (!validateTemplateName(body.fromName, res, 'template-move')) return;
        if (!validateTemplateName(body.toName, res, 'template-move')) return;
        const fromValidated = validateFolderRel(body.fromFolder, res, 'folder', 'template-move');
        if (!fromValidated) return;
        const toValidated = validateFolderRel(body.toFolder, res, 'folder', 'template-move');
        if (!toValidated) return;

        // Refuse moving a source whose target doc is in an unresolved conflict.
        if (
          checkTemplateConflictGate(
            templateDocNameFor(fromValidated.folderRel, body.fromName),
            'template-move',
            res,
          )
        ) {
          return;
        }

        // Tear down the live source template content doc (if open) BEFORE the
        // git-mv relocates the file — otherwise its debounced content store
        // would re-store at the now-stale from-path, resurrecting the moved
        // template.
        await captureAndCloseDocuments(
          [templateDocNameFor(fromValidated.folderRel, body.fromName)],
          'renamed',
        );

        const result = await applyTemplateMove({
          projectDir: fromValidated.resolvedContentDir,
          fromFolder: fromValidated.folderRel,
          fromName: body.fromName,
          toFolder: toValidated.folderRel,
          toName: body.toName,
          // git mv (history-preserving) when the path is tracked; plain disk
          // rename otherwise. `withParentLock` inside renameTrackedPathInGit
          // serializes against concurrent doc renames (git-index safety).
          relocate: async (fromAbs, toAbs) => {
            const movedWithGit = await renameTrackedPathInGit(projectDir, fromAbs, toAbs);
            if (!movedWithGit) renamePathOnDisk(fromAbs, toAbs);
            return movedWithGit;
          },
        });

        if (!result.ok) {
          if (result.error.code === 'TEMPLATE_NOT_FOUND') {
            // Distinguish "inherited" (resolvable from an ancestor) — teach
            // localize-then-move — from "truly absent" — 404.
            const found = findTemplateLeafToRoot(
              fromValidated.resolvedContentDir,
              fromValidated.folderRel,
              body.fromName,
            );
            if (found?.scope === 'inherited') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `Template "${body.fromName}" is inherited from "${found.folder || '(root)'}", not local to "${fromValidated.folderRel || '(root)'}". Move it from the folder that owns it, or create a local copy here first (then move that).`,
                { handler: 'template-move', detail: 'TEMPLATE_INHERITED' },
              );
              return;
            }
            errorResponse(res, 404, 'urn:ok:error:template-not-found', 'Template not found.', {
              handler: 'template-move',
              detail: result.error.message,
            });
            return;
          }
          if (result.error.code === 'TEMPLATE_EXISTS') {
            errorResponse(res, 409, 'urn:ok:error:doc-already-exists', result.error.message, {
              handler: 'template-move',
              detail: result.error.code,
            });
            return;
          }
          const status =
            result.error.code === 'WRITE_ERROR' || result.error.code === 'MOVE_FAILED' ? 500 : 400;
          errorResponse(
            res,
            status,
            status === 500 ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            status === 500 ? 'Failed to move template.' : 'Invalid template move request.',
            {
              handler: 'template-move',
              detail: result.error.code,
              cause: new Error(result.error.message),
            },
          );
          return;
        }

        // Mark the source content doc removed (the move relocated its file) so a
        // stale tab on the old name redirects instead of offering to resurrect
        // it (parity with ordinary doc deletion).
        recentlyRemovedDocs?.setDeleted(templateDocNameFor(fromValidated.folderRel, body.fromName));

        // Optional atomic move+edit: rewrite the relocated template's content.
        // The move already succeeded and persisted the original content, so any
        // failure here is captured and reported AFTER the move is attributed —
        // the rename must not be lost because the edit step failed.
        let contentEditError: { code: string; message: string } | null = null;
        if (body.body !== undefined || body.frontmatter !== undefined) {
          // Preserve the existing (just-moved) body when only `frontmatter` is
          // supplied. If that body can't be read, SKIP the rewrite rather than
          // risk wiping it — defaulting to '' would re-introduce the body-loss
          // bug on a read error; the moved file keeps its original content.
          let writeBody: string | null;
          if (typeof body.body === 'string') {
            writeBody = body.body;
          } else {
            try {
              writeBody = instantiateDoc(
                readFileSync(resolve(toValidated.resolvedContentDir, result.toPath), 'utf-8'),
              );
            } catch {
              writeBody = null;
            }
          }
          if (writeBody === null) {
            contentEditError = {
              code: 'READ_FAILED',
              message:
                'could not read the moved template to apply the metadata change; the move succeeded with the original content intact — retry the edit',
            };
          } else {
            const writeResult = applyTemplateWrite({
              projectDir: toValidated.resolvedContentDir,
              folder: toValidated.folderRel,
              name: body.toName,
              body: writeBody,
              frontmatter: pickFrontmatterFields(body.frontmatter) satisfies TemplateFrontmatter,
            });
            if (!writeResult.ok) contentEditError = writeResult.error;
          }
        }

        // Close the dropped-FSEvent gap for the DESTINATION (parity with
        // put/import): the relocate may have just created `toFolder`'s
        // `.ok/templates/` dir — the brand-new-subdir race where the watcher's
        // create event can be lost. Read the final on-disk bytes (post the
        // optional edit above) so the index entry matches what landed.
        // Best-effort like the helper itself: on a read failure the CRDT/disk
        // copy exists regardless and a rescan re-seeds the index.
        try {
          registerWrittenDocInFileIndex(
            templateDocNameFor(toValidated.folderRel, body.toName),
            readFileSync(resolve(toValidated.resolvedContentDir, result.toPath), 'utf-8'),
          );
        } catch {
          // Unreadable destination — leave index membership to the watcher.
        }

        // The move succeeded — attribute + commit + signal regardless of the
        // optional content edit's outcome, so the rename is never lost when the
        // edit step fails.
        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', toValidated.folderRel, body.toName),
          `template-rename: ${result.fromPath} -> ${result.toPath}`,
          [{ from: result.fromPath, to: result.toPath }],
        );
        scheduleOkArtifactFlush('template-move');
        signalChannel?.('files');

        if (contentEditError) {
          const isServerError =
            contentEditError.code === 'WRITE_ERROR' || contentEditError.code === 'READ_FAILED';
          errorResponse(
            res,
            isServerError ? 500 : 400,
            isServerError ? 'urn:ok:error:internal-server-error' : 'urn:ok:error:invalid-request',
            // Include the destination so the agent can retry the content edit
            // against the moved template without re-deriving where it landed.
            `Template moved to "${result.toPath}", but updating its content failed.`,
            {
              handler: 'template-move',
              detail: contentEditError.code,
              cause: new Error(contentEditError.message),
            },
          );
          return;
        }
        successResponse(
          res,
          200,
          TemplateMoveSuccessSchema,
          { from: result.fromPath, to: result.toPath, committed: result.committed },
          { handler: 'template-move' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to move template.', {
          handler: 'template-move',
          cause: e,
        });
      }
    },
    { handler: 'template-move', method: 'POST' },
  );

  const handleTemplate = methodRouter(
    {
      GET: handleTemplateGet,
      PUT: handleTemplatePut,
      POST: handleTemplateMove,
      DELETE: handleTemplateDelete,
    },
    { handler: 'template' },
  );

  const handleTemplateImport = withValidation(
    TemplateImportRequestSchema,
    async (_req, res, body) => {
      try {
        if (ephemeral) {
          errorResponse(
            res,
            403,
            'urn:ok:error:single-file-mode',
            'Templates are not available in single-file mode.',
            { handler: 'template-import' },
          );
          return;
        }

        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'template-import',
          });
          return;
        }

        const sourcePath = body.sourcePath;
        if (!isSafeDocName(sourcePath)) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid sourcePath.', {
            handler: 'template-import',
          });
          return;
        }

        const sourceDocName = resolveAlias(sourcePath);
        if (isSystemDoc(sourceDocName) || isConfigDoc(sourceDocName)) {
          errorResponse(
            res,
            400,
            'urn:ok:error:reserved-doc-name',
            `'${sourceDocName}' is a reserved document name.`,
            { handler: 'template-import' },
          );
          return;
        }

        const sourceFilePath = resolveContentEntryPath(contentDir, 'file', sourceDocName);
        if (!existsSync(sourceFilePath)) {
          errorResponse(
            res,
            404,
            'urn:ok:error:doc-not-found',
            `Source document not found: ${sourceDocName}.`,
            {
              handler: 'template-import',
            },
          );
          return;
        }

        const existing = hocuspocus.documents.get(sourceDocName);
        if (body.deleteSource) {
          const deleteEngine = getSyncEngine?.();
          const deleteTrackedFiles = new Set(
            deleteEngine ? deleteEngine.getConflicts().map((c) => c.file) : [],
          );
          const conflictedByLifecycle = existing !== undefined && isDocInConflict(existing);
          const conflictedByStore = deleteTrackedFiles.has(sourcePath);
          if (conflictedByLifecycle || conflictedByStore) {
            respondDocInConflict(
              res,
              new DocInConflictError({ file: sourcePath }),
              'template-import',
            );
            return;
          }
        }

        // Read source content
        let sourceContent = '';
        if (existing) {
          sourceContent = existing.getText('source').toString();
        } else {
          const dc = await hocuspocus.openDirectConnection(sourceDocName);
          try {
            const document = dc.document;
            if (!document) {
              errorResponse(
                res,
                500,
                'urn:ok:error:doc-not-available',
                'Source document is not available.',
                {
                  handler: 'template-import',
                },
              );
              return;
            }
            sourceContent = document.getText('source').toString();
          } finally {
            await dc.disconnect();
          }
        }

        // Determine target template name
        let name = body.name;
        if (!name) {
          const { basename } = splitContentPath(sourcePath);
          const nameWithoutExt = basename.replace(/\.(md|mdx)$/i, '');
          name = nameWithoutExt.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
          name = name.replace(/^[-_]+|[-_]+$/g, '');
          name ||= 'imported-template';
        }

        if (!validateTemplateName(name, res, 'template-import')) return;

        const validated = validateFolderRel(body.targetFolder, res, 'folder', 'template-import');
        if (!validated) return;

        if (
          checkTemplateConflictGate(
            templateDocNameFor(validated.folderRel, name),
            'template-import',
            res,
          )
        )
          return;

        // Parse existing frontmatter of the source file to extract the title/description/tags
        const { frontmatter: sourceFmText, body: sourceBody } = stripFrontmatter(sourceContent);
        const cleanFmText = unwrapFrontmatterFences(sourceFmText);
        let sourceFmObj: Record<string, unknown> = {};
        try {
          if (cleanFmText.trim()) {
            sourceFmObj = parseYaml(cleanFmText) as Record<string, unknown>;
          }
        } catch {
          // Malformed frontmatter — treat the source as having none.
        }

        const templateTitle =
          body.title || (sourceFmObj?.title as string) || extractPageTitle(sourceContent, name);
        const templateDescription = (sourceFmObj?.description as string) || '';
        const templateTags = Array.isArray(sourceFmObj?.tags) ? (sourceFmObj.tags as string[]) : [];

        // For the starter content, we can use the original document frontmatter but remove `template:`
        // if it somehow got there. Keep other fields. We also drop `title` so it doesn't get baked into every instance.
        const starterFmObj = { ...sourceFmObj };
        delete starterFmObj.template;
        delete starterFmObj.title;

        let starterContent = '';
        if (Object.keys(starterFmObj).length > 0) {
          const fmYaml = stringifyYaml(starterFmObj);
          starterContent = `${fmYaml.trim()}\n`;
        }
        starterContent = starterContent ? `---\n${starterContent}---\n${sourceBody}` : sourceBody;

        const composed = composeTemplateContent({
          name,
          body: starterContent,
          frontmatter: {
            title: templateTitle,
            description: templateDescription,
            tags: templateTags,
          },
        });

        if (!composed.ok) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid template request.', {
            handler: 'template-import',
            detail: composed.error.code,
            cause: new Error(composed.error.message),
          });
          return;
        }

        const templateFilePath = resolve(
          validated.resolvedContentDir,
          validated.folderRel,
          '.ok',
          'templates',
          `${name}.md`,
        );
        const templateCreated = !existsSync(templateFilePath);
        const templateRelPath = relative(validated.resolvedContentDir, templateFilePath)
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');
        const templateDocName = templateDocNameFor(validated.folderRel, name);

        const { agentId, agentName, colorSeed, clientName } = extractAgentIdentity(
          body as unknown as Record<string, unknown>,
        );
        const templateSession = await sessionManager.getSession(templateDocName, agentId, {
          displayName: agentName,
          colorSeed,
          clientName,
        });
        templateSession.dc.document.transact(() => {
          composeAndWriteRawBody(templateSession.dc.document, composed.content, 'agent');
        }, templateSession.origin);

        const templateFlush = await flushDiskAndDetectOutcome(templateDocName);
        if (templateFlush?.kind === 'failure') {
          respondPersistenceFailure(res, templateFlush.failure, 'template-import');
          return;
        }
        if (templateFlush?.kind === 'divergence') {
          respondDiskDivergence(res, 'template-import');
          return;
        }

        // Close the dropped-FSEvent gap at the source (see helper): the flush
        // may have just created the target folder's `.ok/templates/` dir —
        // exactly the brand-new-subdir race where the watcher's create event
        // can be lost. Same net as the sibling agent-write handlers.
        registerWrittenDocInFileIndex(templateDocName, composed.content);

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('template', validated.folderRel, name),
          `template-import: ${templateRelPath}`,
        );

        if (body.deleteSource) {
          const deletedDocNames = [sourceDocName];
          await captureAndCloseDocuments(deletedDocNames, 'deleted-upstream');
          if (recentlyRemovedDocs) {
            recentlyRemovedDocs.setDeleted(sourceDocName);
          }
          tracedUnlinkSync(sourceFilePath);
          mutateFileIndex?.({
            kind: 'delete',
            path: sourceFilePath,
            docName: sourceDocName,
          });
        }

        scheduleOkArtifactFlush('template-import');
        signalChannel?.('files');

        successResponse(
          res,
          200,
          TemplateImportSuccessSchema,
          {
            path: templateRelPath,
            created: templateCreated,
            warnings: composed.warnings,
          },
          { handler: 'template-import' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to import template.',
          {
            handler: 'template-import',
            cause: e,
          },
        );
      }
    },
    { handler: 'template-import', method: 'POST' },
  );

  return createApiRouteGroup(
    {
      '/api/folder-config': handleFolderConfig,
      '/api/template': handleTemplate,
      '/api/template/import': handleTemplateImport,
    },
    {
      mutating: ['/api/folder-config', '/api/template', '/api/template/import'],
    },
  );
}
