/**
 * The workspace-tools group — `/api/search`, `/api/link-preview`,
 * `/api/skill-targets`, `/api/saved-themes` + `/api/saved-theme`, and
 * `/api/generated-index/settings` — natively routed together. What the
 * handlers closed over in the extension arrives as
 * {@link WorkspaceToolsRouteDeps}, the handler bodies are unchanged, and the
 * extension composes this group's table into its `nativeApi` handle while
 * the legacy dispatch record loses the paths in the same change.
 * `searchService` is constructed in the extension (its inputs — file-index
 * generation, semantic backend, skills-root resolution — stay there) and is
 * consumed here by reference.
 *
 * The multi-verb paths (`search`, `skill-targets`, `saved-theme`,
 * `generated-index/settings`) dispatch through the shared `methodRouter`
 * helper exactly as they did in the legacy record.
 * `ApiRouteTable.isMutating` is URL-keyed (no method), so a path is mutating
 * when ANY of its verbs mutates — reproducing the legacy `MUTATING_ROUTES`
 * membership exactly (`/api/skill-targets` and
 * `/api/generated-index/settings` ride the mutating gate on GET too, as they
 * always have). Per-verb granularity would widen the shared pipeline
 * signature for a telemetry-tag-only difference: the read half of the
 * DNS-rebinding defense applies the same loopback + workspace-Host checks to
 * every `/api/*` request, so admission outcomes are identical either way.
 */

import { resolve } from 'node:path';
import {
  EmptyRequestSchema,
  LinkPreviewRequestSchema,
  LinkPreviewResponseSchema,
  SavedThemeDeleteSuccessSchema,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
  SearchRequestSchema,
  type SearchSource,
  SearchSuccessSchema,
  SkillTargetsGetSuccessSchema,
  SkillTargetsPutRequestSchema,
  SkillTargetsPutSuccessSchema,
  type WorkspaceSearchIntent,
  type WorkspaceSearchRanking,
  type WorkspaceSearchScope,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { isActivatedSkillRoot, knownSkillRootsFor } from '../in-place-skills.ts';
import { guardedFetch } from '../link-preview/guarded-fetch.ts';
import { buildLinkPreviewMetadata, type GuardedFetch } from '../link-preview/metadata.ts';
import { LinkPreviewCache, type LinkPreviewOutcome } from '../link-preview/preview-cache.ts';
import { classifyLinkPreviewRequest } from '../link-preview/request-gate.ts';
import type { PinoLogger } from '../logger.ts';
import { scanSavedThemes } from '../saved-themes-store.ts';
import { deleteSavedTheme, saveSavedTheme, updateSavedTheme } from '../saved-themes-write.ts';
import type { SearchService } from '../services/search.ts';
import {
  linkEditorSkillFolder,
  previewEditorFolderLink,
  scanSkillFolderStates,
  unlinkEditorSkillFolder,
} from '../skill-folder-links.ts';
import {
  readFolderExpectations,
  recordFolderExpectation,
  recordKnownSkillRoot,
} from '../skill-placements.ts';
import { resolveSkillTargets } from '../skill-projection.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { parseQuery } from './handler-utils.ts';
import { methodRouter } from './method-router.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

const GeneratedIndexSettingsStatusSchema = z.object({
  enabled: z.boolean(),
  active: z.boolean(),
  git: z.object({
    state: z.enum(['not-applicable', 'ready', 'missing', 'conflict', 'unavailable']),
    ownership: z.enum(['open-knowledge', 'existing']).optional(),
  }),
  applied: z.boolean().optional(),
  reason: z.enum(['git-conflict', 'git-unavailable', 'config-write']).optional(),
});
const GeneratedIndexSettingsRequestSchema = z.object({ enabled: z.boolean() }).strict();

export type GeneratedIndexSettingsStatus = z.infer<typeof GeneratedIndexSettingsStatusSchema>;

export interface WorkspaceToolsRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  /** The resolved skills-home root (`homeDirOverride ?? homedir()`). */
  skillsHome: string;
  /** Home-dir seam so a rig / embedded host never touches the REAL `~/.ok`. */
  homeDirOverride: string | undefined;
  savedThemeLockTimeoutMs: number | undefined;
  /** No-project ephemeral single-file mode (link-preview cache stays in memory). */
  ephemeral: boolean | undefined;
  log: PinoLogger;
  /** The extension's CC1 change-signal emitter (already system-doc-guarded). */
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  /**
   * The extension's search capability service — its inputs (file index +
   * generation, semantic backend, skills root) stay in the extension, so it is
   * consumed by reference rather than moved.
   */
  searchService: SearchService;
  /** Test seam for the SSRF-guarded outbound fetch. */
  linkPreviewFetch: GuardedFetch | undefined;
  getLinkPreviewsEnabled: (() => boolean) | undefined;
  /** Read and mutate the config + Git-attribute joint admission state. */
  getGeneratedIndexSettingsStatus: (() => GeneratedIndexSettingsStatus) | undefined;
  setGeneratedIndexEnabled:
    | ((enabled: boolean) => Promise<GeneratedIndexSettingsStatus>)
    | undefined;
}

export function createWorkspaceToolsRoutes(deps: WorkspaceToolsRouteDeps): ApiRouteGroup {
  const {
    contentDir,
    projectDir,
    skillsHome,
    homeDirOverride,
    savedThemeLockTimeoutMs,
    ephemeral,
    log,
    signalChannel,
    searchService,
    linkPreviewFetch,
    getLinkPreviewsEnabled,
    getGeneratedIndexSettingsStatus,
    setGeneratedIndexEnabled,
  } = deps;

  // ── Saved themes (`/api/saved-themes` list, `/api/saved-theme` mutations) ──
  // The store is a user-global folder of scheme files the renderer can't reach;
  // save/delete/list run here. Discovery is by scan (no live watcher in v1), and
  // the home is the same `homeDirOverride` seam the skills store uses so tests
  // isolate against a tempdir without touching `os.homedir()`.

  const handleSavedThemesList = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        const { entries, truncated } = scanSavedThemes({ homedirOverride: homeDirOverride });
        // Entries carry their own `ok` discriminator: usable themes ship their
        // palette for the picker preview; unusable ones ship a warning `code` so
        // a file the user placed is listed, never silently missing.
        successResponse(
          res,
          200,
          SavedThemesListSuccessSchema,
          { themes: entries, truncated },
          { handler: 'saved-themes-list' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to list saved themes.',
          {
            handler: 'saved-themes-list',
            cause: e,
          },
        );
      }
    },
    { handler: 'saved-themes-list', method: 'GET', skipBodyParse: true },
  );

  const handleSavedThemeSave = withValidation(
    SavedThemeSaveRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await saveSavedTheme({
          name: body.name,
          stem: body.stem,
          scheme: body.scheme,
          extension: body.extension,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-save',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          if (result.code === 'name-taken') {
            // Refuse-and-prompt: a collision never overwrites prior work.
            errorResponse(
              res,
              409,
              'urn:ok:error:theme-name-taken',
              'A saved theme with that name already exists.',
              { handler: 'saved-theme-save', detail: body.name },
            );
            return;
          }
          // Restore stems remain strict; a new human-facing name only fails when
          // it is empty. The specific cause rides `detail` so the save form can
          // localize the reason.
          errorResponse(
            res,
            400,
            'urn:ok:error:theme-name-invalid',
            'That name cannot be used as a theme id.',
            { handler: 'saved-theme-save', detail: result.code },
          );
          return;
        }
        successResponse(
          res,
          201,
          SavedThemeSaveSuccessSchema,
          { id: result.id, filename: result.filename },
          { handler: 'saved-theme-save' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to save theme.', {
          handler: 'saved-theme-save',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-save', method: 'POST' },
  );

  const handleSavedThemeDelete = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const id = parseQuery(req).get('id') ?? '';
        if (id === '') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing theme id.', {
            handler: 'saved-theme-delete',
          });
          return;
        }
        const result = await deleteSavedTheme({
          id,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-delete',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          const conflict = result.code !== 'invalid-id';
          errorResponse(
            res,
            conflict ? 409 : 400,
            'urn:ok:error:invalid-request',
            'Cannot delete saved theme.',
            {
              handler: 'saved-theme-delete',
              detail: result.code,
            },
          );
          return;
        }
        // Deleting an id that names no file is a benign no-op (`existed: false`),
        // and deleting one currently assigned to a mode slot is allowed — the
        // config's read-time fallback makes the dangling reference harmless.
        successResponse(
          res,
          200,
          SavedThemeDeleteSuccessSchema,
          result.existed
            ? { existed: true, filename: result.filename, scheme: result.scheme }
            : { existed: false },
          { handler: 'saved-theme-delete' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to delete theme.', {
          handler: 'saved-theme-delete',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-delete', method: 'DELETE', skipBodyParse: true },
  );

  const handleSavedThemeUpdate = withValidation(
    SavedThemeUpdateRequestSchema,
    async (_req, res, body) => {
      try {
        const result = await updateSavedTheme({
          id: body.id,
          scheme: body.scheme,
          homedirOverride: homeDirOverride,
          lockTimeoutMs: savedThemeLockTimeoutMs,
        });
        if (!result.ok) {
          if (result.code === 'lock-timeout') {
            errorResponse(
              res,
              503,
              'urn:ok:error:concurrent-operation',
              'Saved themes are temporarily busy.',
              {
                handler: 'saved-theme-update',
                detail: result.code,
                extraHeaders: { 'Retry-After': '5' },
              },
            );
            return;
          }
          if (result.code === 'not-found') {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Saved theme not found.', {
              handler: 'saved-theme-update',
            });
            return;
          }
          if (result.code === 'ambiguous-id' || result.code === 'unsafe-target') {
            const message =
              result.code === 'ambiguous-id'
                ? 'Multiple saved theme files claim that id.'
                : 'The saved theme id conflicts with a file that cannot be safely updated.';
            errorResponse(res, 409, 'urn:ok:error:invalid-request', message, {
              handler: 'saved-theme-update',
              detail: result.code,
            });
            return;
          }
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Not a saved theme id.', {
            handler: 'saved-theme-update',
            detail: result.code,
          });
          return;
        }
        successResponse(
          res,
          200,
          SavedThemeUpdateSuccessSchema,
          { id: result.id, filename: result.filename },
          { handler: 'saved-theme-update' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to update theme.', {
          handler: 'saved-theme-update',
          cause: e,
        });
      }
    },
    { handler: 'saved-theme-update', method: 'PUT' },
  );

  const handleSavedTheme = methodRouter(
    { POST: handleSavedThemeSave, PUT: handleSavedThemeUpdate, DELETE: handleSavedThemeDelete },
    { handler: 'saved-theme' },
  );

  const handleSkillTargetsGet = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // Store retirement: the committed `.ok/skill-targets.json` set is dead —
        // targets are DETECTED from the project's configured editors, and
        // per-skill reach lives in each skill's install menu.
        const targets = resolveSkillTargets(projectDir ?? '');
        // Folder-link receipt vs disk: a recorded expectation that no longer
        // matches the observed state is DRIFT — passive disclosure only (the
        // "changed outside" chip); the next explicit verb wins + re-records.
        const withDrift = (
          base: string,
          f: ReturnType<typeof scanSkillFolderStates>[number],
        ): { drift?: true; expected?: string } => {
          const exp = readFolderExpectations(base)[f.root];
          if (exp === undefined) return {};
          const matches =
            exp.expect === 'link'
              ? f.state === 'linked' && f.target === exp.target
              : f.state === 'own';
          if (matches) return {};
          return {
            drift: true,
            expected: exp.expect === 'link' ? `link → ${exp.target}` : 'own folder',
          };
        };
        successResponse(
          res,
          200,
          SkillTargetsGetSuccessSchema,
          {
            targets,
            configured: false,
            // Only folders OK may actually write to on this machine. A row here
            // is a destination — the Folders surface links and unlinks it — so a
            // root under a dotdir that does not exist is an offer to create that
            // dotdir for a tool the user never installed. Custom roots are always
            // kept; see `isActivatedSkillRoot`.
            folders: [
              ...(projectDir
                ? scanSkillFolderStates(contentDir, knownSkillRootsFor(contentDir, 'project'))
                    .filter((f) => isActivatedSkillRoot(contentDir, 'project', f.root))
                    .map((f) => ({
                      ...f,
                      scope: 'project' as const,
                      ...withDrift(contentDir, f),
                    }))
                : []),
              ...scanSkillFolderStates(skillsHome, knownSkillRootsFor(skillsHome, 'global'))
                .filter((f) => isActivatedSkillRoot(skillsHome, 'global', f.root))
                .map((f) => ({
                  ...f,
                  scope: 'global' as const,
                  ...withDrift(skillsHome, f),
                })),
            ],
          },
          { handler: 'skill-targets-get' },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read skill targets.',
          { handler: 'skill-targets-get', cause: e },
        );
      }
    },
    { handler: 'skill-targets-get', method: 'GET', skipBodyParse: true },
  );

  const handleSkillTargetsPut = withValidation(
    SkillTargetsPutRequestSchema,
    async (_req, res, body) => {
      try {
        {
          const fa = body.folderAction;
          const base = fa.scope === 'project' ? contentDir : skillsHome;
          if (fa.scope === 'project' && !projectDir) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot manage skill folders — no project root is resolved for this server.',
              { handler: 'skill-targets-put', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          // DECLARE a new custom root (rows/link-targets from declaration,
          // not first placement). Shape-validated only — it's a declaration,
          // not a write; the folder stays absent until something lands there.
          if (fa.action === 'add-root') {
            const raw = fa.root.replace(/\\/g, '/');
            const rel = raw.replace(/\/+$/g, '');
            const segs = rel.split('/').filter((seg) => seg !== '' && seg !== '.');
            if (
              rel === '' ||
              rel.startsWith('/') ||
              rel.startsWith('~') ||
              /^[A-Za-z]:/.test(rel) ||
              rel.includes('\x00') ||
              segs.length === 0 ||
              segs.some((seg) => seg === '..')
            ) {
              errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid folder path.', {
                handler: 'skill-targets-put',
                detail: fa.root,
              });
              return;
            }
            await recordKnownSkillRoot(base, segs.join('/'));
            signalChannel?.('files');
            successResponse(
              res,
              200,
              SkillTargetsPutSuccessSchema,
              {
                targets: resolveSkillTargets(projectDir ?? ''),
                reprojected: [],
                bundleHosts: [],
                removedFrom: [],
              },
              { handler: 'skill-targets-put' },
            );
            return;
          }
          // Folder verbs operate on KNOWN roots only (standard host roots +
          // ledger-known custom roots) — arbitrary paths never reach the
          // link/unlink primitives. The link target is an EXPLICIT user pick;
          // no root is ever assumed.
          const knownRoots = new Set(
            knownSkillRootsFor(base, fa.scope)
              .map((r) => r.root)
              .filter((r) => !r.startsWith('/') && !r.split('/').includes('..')),
          );
          const target = fa.action === 'link' ? (fa.target ?? '') : fa.root;
          if (
            !knownRoots.has(fa.root) ||
            (fa.action === 'link' && (!knownRoots.has(target) || fa.root === target))
          ) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Folder and target must be distinct standard skills roots.',
              { handler: 'skill-targets-put', detail: `${fa.root} -> ${target}` },
            );
            return;
          }
          // PREVIEW: classify the merge and return it, writing nothing — the
          // Folders surface discloses what a link moves and deletes before it
          // asks for it. No receipt, no change signal: nothing changed.
          if (fa.action === 'link' && fa.preview) {
            const p = previewEditorFolderLink({
              base,
              folderRel: fa.root,
              targetRootRel: target,
            });
            const plan = p.kind === 'plan' ? p.plan : null;
            successResponse(
              res,
              200,
              SkillTargetsPutSuccessSchema,
              {
                targets: resolveSkillTargets(projectDir ?? ''),
                reprojected: [],
                bundleHosts: [],
                removedFrom: [],
                preview: {
                  moves: plan
                    ? [...plan.linkedBundlesToMove.map(({ name }) => name), ...plan.toMove]
                    : [],
                  drops: plan?.toDrop ?? [],
                  removes: plan?.removes ?? [],
                  replaces: plan?.liveDestLinks ?? [],
                  conflicts: p.kind === 'conflicts' ? p.conflicts : [],
                  strays: p.kind === 'stray-entries' ? p.strays : [],
                },
              },
              { handler: 'skill-targets-put' },
            );
            return;
          }
          const result =
            fa.action === 'link'
              ? linkEditorSkillFolder({ base, folderRel: fa.root, targetRootRel: target })
              : unlinkEditorSkillFolder({
                  base,
                  folderRel: fa.root,
                  ...(fa.exclude !== undefined ? { exclude: fa.exclude } : {}),
                });
          if (!result.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:invalid-request',
              result.reason === 'conflicts'
                ? `Cannot link — differing skills exist in both folders: ${(result.conflicts ?? []).join(', ')}. Resolve them first.`
                : result.reason === 'stray-entries'
                  ? `Cannot link — the folder holds non-skill entries: ${(result.strays ?? []).join(', ')}.`
                  : result.reason === 'partial-move'
                    ? `The merge stopped partway (${(result.moved ?? []).length} skill(s) already moved — nothing lost). Run Link again to resume and complete it. (${result.error ?? ''})`
                    : result.reason === 'not-linked'
                      ? 'That folder is not a symlink — nothing to unlink.'
                      : 'That folder cannot be linked (it is already a link or the same directory).',
              { handler: 'skill-targets-put', detail: result.reason },
            );
            return;
          }
          // RECEIPT: record the expected folder form so an external rewrite
          // (symlink deleted, re-pointed, or re-materialized) renders a
          // passive "changed outside" chip. The next explicit verb wins.
          await recordFolderExpectation(
            base,
            fa.root,
            fa.action === 'link' ? { expect: 'link', target } : { expect: 'own' },
          );
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillTargetsPutSuccessSchema,
            {
              targets: resolveSkillTargets(projectDir ?? ''),
              reprojected: [],
              bundleHosts: [],
              removedFrom: [],
              folder: { moved: result.moved, dropped: result.dropped, linked: result.linked },
            },
            { handler: 'skill-targets-put' },
          );
          return;
        }
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to set skill targets.',
          { handler: 'skill-targets-put', cause: e },
        );
      }
    },
    { handler: 'skill-targets-put', method: 'PUT' },
  );

  const handleSkillTargets = methodRouter(
    { GET: handleSkillTargetsGet, PUT: handleSkillTargetsPut },
    { handler: 'skill-targets' },
  );

  function parseSearchRanking(value: unknown): WorkspaceSearchRanking | undefined {
    return value === 'navigation' || value === 'relevance' ? value : undefined;
  }

  function parseSearchIntent(value: unknown): WorkspaceSearchIntent {
    if (value === 'autocomplete' || value === 'full_text' || value === 'omnibar') return value;
    return 'omnibar';
  }

  function parseSearchScopes(value: unknown): WorkspaceSearchScope[] | undefined {
    const rawScopes =
      typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : undefined;
    if (!rawScopes) return undefined;
    const scopes = rawScopes.filter(
      (scope): scope is WorkspaceSearchScope =>
        scope === 'page' || scope === 'folder' || scope === 'content' || scope === 'file',
    );
    return scopes.length > 0 ? scopes : undefined;
  }

  /** Parse the opt-in `semantic` param from a query string / JSON body value. */
  function parseSemanticParam(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  /** Resolve the bounded `source` telemetry label; unknown / absent → `http`. */
  function parseSearchSource(value: unknown): SearchSource {
    return value === 'omnibar' || value === 'mcp' || value === 'http' ? value : 'http';
  }

  const handleSearchGet = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (req, res) => {
        const params = parseQuery(req);
        const limit = params.get('limit');
        const query = params.get('query') ?? '';
        const intent = parseSearchIntent(params.get('intent'));
        const ranking = parseSearchRanking(params.get('ranking'));
        const scopes = parseSearchScopes(params.get('scope') ?? params.get('scopes'));
        const semanticParam = parseSemanticParam(params.get('semantic'));
        const source = parseSearchSource(params.get('source'));
        const limitNum = limit === null ? undefined : Number(limit);

        if (query.length > 200) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Query is too long (max 200 chars).',
            { handler: 'search-get' },
          );
          return;
        }
        const body = await searchService.buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit: limitNum,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, body, { handler: 'search-get' });
      },
      { handler: 'search-get', title: 'Failed to search workspace.' },
    ),
    { handler: 'search-get', method: 'GET', skipBodyParse: true },
  );

  const handleSearchPost = withValidation(
    SearchRequestSchema,
    catchErrors(
      async (_req, res, body) => {
        const query = typeof body.query === 'string' ? body.query : '';
        const intent = parseSearchIntent(body.intent);
        const ranking = parseSearchRanking(body.ranking);
        const scopes = parseSearchScopes(body.scopes ?? body.scope);
        const limit = typeof body.limit === 'number' ? body.limit : undefined;
        const semanticParam = parseSemanticParam(body.semantic);
        const source = parseSearchSource(body.source);

        if (query.length > 200) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Query is too long (max 200 chars).',
            { handler: 'search-post' },
          );
          return;
        }
        const responseBody = await searchService.buildSearchResponse({
          query,
          intent,
          ranking,
          scopes,
          limit,
          semanticParam,
          source,
        });
        successResponse(res, 200, SearchSuccessSchema, responseBody, { handler: 'search-post' });
      },
      { handler: 'search-post', title: 'Failed to search workspace.' },
    ),
    { handler: 'search-post', method: 'POST' },
  );

  const handleSearch = methodRouter(
    { GET: handleSearchGet, POST: handleSearchPost },
    { handler: 'search' },
  );

  // ───────────────────── Link preview (external hover cards) ─────────────────
  // Fetches page metadata for an external link on the user's behalf, so it is
  // guarded on two independent axes: an anti-proxy gate decides WHO may ask, and
  // the SSRF-guarded fetch decides WHERE the server may reach. The gate refuses
  // absent / `null` / non-loopback Origins that the shared /api/* allowlist would
  // wave through, because an admitted caller would be a readable server-side
  // request-forgery proxy for any local browser tab. Read-only — kept out of
  // MUTATING_ROUTES.
  const LINK_PREVIEW_HANDLER = 'link-preview';
  // Ephemeral single-file mode keeps zero user-dir artifacts, so its cache stays
  // in memory; otherwise it lives beside the other project-local sidecars.
  const linkPreviewCacheDir = ephemeral
    ? null
    : resolve(projectDir ?? contentDir, '.ok', 'local', 'link-previews');
  const linkPreviewCache = new LinkPreviewCache({ cacheDir: linkPreviewCacheDir });
  // Load the disk cache once, lazily, before the first lookup. init() never
  // throws; serializing it ahead of load() keeps a warm entry from being
  // clobbered by a late disk read.
  let linkPreviewCacheInit: Promise<void> | null = null;
  const ensureLinkPreviewCacheReady = (): Promise<void> => {
    linkPreviewCacheInit ??= linkPreviewCache.init();
    return linkPreviewCacheInit;
  };
  const linkPreviewFetchImpl: GuardedFetch = linkPreviewFetch ?? guardedFetch;

  // The cache-miss path: one SSRF-guarded page fetch, a bounded head-scan parse,
  // and a favicon fetch through the SAME chokepoint. Never throws — the guard
  // and the parser each absorb their own failures into a bounded reason.
  async function computeLinkPreview(rawUrl: string): Promise<LinkPreviewOutcome> {
    const fetched = await linkPreviewFetchImpl(rawUrl);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const metadata = await buildLinkPreviewMetadata({
      html: new TextDecoder().decode(fetched.body),
      requestUrl: rawUrl,
      finalUrl: fetched.finalUrl,
      fetch: linkPreviewFetchImpl,
    });
    return { ok: true, metadata };
  }

  // The egress opt-in is enforced HERE, not only in the renderer: the anti-proxy
  // gate admits ANY loopback http(s) origin by design, so without this check a
  // second local app could drive outbound fetches while the user has previews
  // OFF. Fail-closed (absent getter or a throwing read = disabled) and evaluated
  // fresh per request so a Settings toggle applies without a restart.
  const linkPreviewsEnabled = (): boolean => {
    try {
      return getLinkPreviewsEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const handleLinkPreview = withValidation(
    LinkPreviewRequestSchema,
    async (_req, res, body) => {
      try {
        // Checked BEFORE the cache is touched so the disabled path can never
        // record a negative entry that would outlive re-enabling.
        if (!linkPreviewsEnabled()) {
          // Outcome instrumentation: one greppable category per request.
          // Category ONLY, never the URL, hostname, resolved IP, or fetched
          // content.
          log.debug({ outcome: 'disabled' }, '[link-preview] request outcome');
          successResponse(
            res,
            200,
            LinkPreviewResponseSchema,
            { ok: false, reason: 'disabled' },
            { handler: LINK_PREVIEW_HANDLER },
          );
          return;
        }
        await ensureLinkPreviewCacheReady();
        // Side flag on the compute closure: load() invokes compute only on a
        // cache miss, so hit-vs-computed falls out here without widening the
        // cache API.
        let computed = false;
        const outcome = await linkPreviewCache.load(body.url, () => {
          computed = true;
          return computeLinkPreview(body.url);
        });
        // Persist is best-effort and never throws; fire-and-forget so a slow disk
        // write can't stall the response.
        void linkPreviewCache.persist();
        // Rejections cross the wire with ONE coarse reason. The granular guard
        // taxonomy (private-ip / dns-failure / non-html / …) stays in local logs
        // and the on-disk cache for debugging, but returning it would let a
        // loopback caller pair chosen hostnames with reasons to enumerate
        // internal names; the renderer ignores the field either way.
        const wireOutcome: LinkPreviewOutcome = outcome.ok
          ? outcome
          : { ok: false, reason: 'blocked' };
        // Outcome instrumentation: one greppable category per request
        // (disabled / cache-hit / fetched-ok / fallback). A negative cache hit
        // logs cache-hit (served without a fetch). Category ONLY, never the
        // URL, hostname, resolved IP, or fetched content; the granular
        // rejection taxonomy is already logged at the guarded-fetch chokepoint.
        log.debug(
          { outcome: computed ? (outcome.ok ? 'fetched-ok' : 'fallback') : 'cache-hit' },
          '[link-preview] request outcome',
        );
        successResponse(res, 200, LinkPreviewResponseSchema, wireOutcome, {
          handler: LINK_PREVIEW_HANDLER,
        });
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
          handler: LINK_PREVIEW_HANDLER,
          cause: e,
        });
      }
    },
    {
      handler: LINK_PREVIEW_HANDLER,
      method: 'POST',
      // Reject a cross-origin / null-origin / non-JSON caller before the body is
      // read, so a bypass request never reaches the outbound fetch.
      preBodyGate: (req, res) => {
        const verdict = classifyLinkPreviewRequest({
          origin: req.headers.origin,
          contentType: req.headers['content-type'],
        });
        if (verdict.ok) return true;
        if (verdict.reason === 'origin') {
          errorResponse(res, 403, 'urn:ok:error:invalid-origin', 'Origin not allowed.', {
            handler: LINK_PREVIEW_HANDLER,
          });
        } else {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Content-Type must be application/json.',
            { handler: LINK_PREVIEW_HANDLER },
          );
        }
        return false;
      },
    },
  );

  const handleGetGeneratedIndexSettings = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!getGeneratedIndexSettingsStatus) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
          handler: 'generated-index-settings-get',
        });
        return;
      }
      successResponse(
        res,
        200,
        GeneratedIndexSettingsStatusSchema,
        getGeneratedIndexSettingsStatus(),
        {
          handler: 'generated-index-settings-get',
          extraHeaders: { 'Cache-Control': 'no-store' },
        },
      );
    },
    { handler: 'generated-index-settings-get', method: 'GET', skipBodyParse: true },
  );

  const handleSetGeneratedIndexSettings = withValidation(
    GeneratedIndexSettingsRequestSchema,
    async (_req, res, body) => {
      if (!setGeneratedIndexEnabled) {
        errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
          handler: 'generated-index-settings-set',
        });
        return;
      }
      const result = await setGeneratedIndexEnabled(body.enabled);
      successResponse(res, 200, GeneratedIndexSettingsStatusSchema, result, {
        handler: 'generated-index-settings-set',
        extraHeaders: { 'Cache-Control': 'no-store' },
      });
    },
    { handler: 'generated-index-settings-set', method: 'POST' },
  );

  const handleGeneratedIndexSettings = methodRouter(
    { GET: handleGetGeneratedIndexSettings, POST: handleSetGeneratedIndexSettings },
    { handler: 'generated-index-settings' },
  );

  // Byte-exact legacy `MUTATING_ROUTES` membership for this group. The
  // multi-verb paths (`skill-targets` GET+PUT, `generated-index/settings`
  // GET+POST, `saved-theme` POST/PUT/DELETE) are mutating on every verb,
  // exactly as before the lift; `/api/saved-themes` (GET list),
  // `/api/search`, and `/api/link-preview` stay on the read posture,
  // exactly as before.
  return createApiRouteGroup(
    {
      '/api/search': handleSearch,
      '/api/link-preview': handleLinkPreview,
      '/api/skill-targets': handleSkillTargets,
      '/api/saved-themes': handleSavedThemesList,
      '/api/saved-theme': handleSavedTheme,
      '/api/generated-index/settings': handleGeneratedIndexSettings,
    },
    { mutating: ['/api/skill-targets', '/api/saved-theme', '/api/generated-index/settings'] },
  );
}
