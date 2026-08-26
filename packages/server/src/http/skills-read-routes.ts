/**
 * The skills + templates read family — `comment-counts`, `skills/installed`,
 * `templates`, `skill/install-state` — the seventh natively-routed Wave 2
 * group. Same lift shape as the earlier groups: what the handlers closed over
 * in the extension arrives as {@link SkillsReadRouteDeps}, the handler bodies
 * are unchanged, and the extension composes this group's table into its
 * `nativeApi` handle while the legacy dispatch record loses the paths in the
 * same change.
 *
 * `/api/skills` (the skills-list read) deliberately stays in the extension: its
 * handler reads and reassigns the shared mutable skills-catalog generation +
 * cache (`skillsCatalogGen` / `skillsListCache`), which are bumped from ~20
 * legacy sites (the CC1 `files` signal, every mutating skill handler). It moves
 * with the skills mutation family, when that cluster migrates. The installed
 * catalog cache stays there too and is consumed here by reference through
 * `enumerateInstalledSkillsCached`.
 *
 * `skill/install-state` keeps its `checkLocalOpSecurity` pre-body gate — lifted
 * as a dep so the loopback + DNS-rebinding refusal travels with the handler.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CommentCountsSuccessSchema,
  EmptyRequestSchema,
  isDetectedSkillInProject,
  isSkillOutsideOpenProject,
  SkillInstallStateSuccessSchema,
  SkillsInstalledSuccessSchema,
  TemplatesListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { enumerateInstalledSkills } from '@inkeep/open-knowledge-core/skills-catalog';
import type { CommentService } from '../comments/comment-service.ts';
import { resolveProjectTemplates } from '../content/templates-resolver.ts';
import { scanGlobalInPlaceSkills, scanInPlaceSkills } from '../in-place-skills.ts';
import { readSkillInstallStateSnapshot } from '../skill-state.ts';
import type { ApiRouteTable } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsReadRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  /** Home-dir seam so a rig / embedded host never scans the REAL ~/.claude. */
  homeDirOverride: string | undefined;
  /** `homeDirOverride ?? homedir()` — the resolved skills-home root. */
  skillsHome: string;
  /** The extension's docName safety predicate (path-traversal refusal). */
  isSafeDocName: (docName: string) => boolean;
  /** Only `countThreads` is read (comment-counts); narrowed to it. */
  commentService: Pick<CommentService, 'countThreads'>;
  /**
   * The extension's generation-cached installed-skills enumerator — closes over
   * the shared `installedCatalogCache` / `skillsCatalogGen` that stay in the
   * extension, so it is consumed by reference rather than moved.
   */
  enumerateInstalledSkillsCached: (
    opts: Parameters<typeof enumerateInstalledSkills>[0],
  ) => ReturnType<typeof enumerateInstalledSkills>;
  /** The extension's shared local-op security gate (emits RFC 9457 on refusal). */
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
}

export interface SkillsReadRoutes {
  /** Hono patterns for the native mount (`NativeApiHandle.paths`). */
  paths: readonly string[];
  /** The group's view for the shared /api/* admission pipeline. */
  table: ApiRouteTable;
}

export function createSkillsReadRoutes(deps: SkillsReadRouteDeps): SkillsReadRoutes {
  const {
    contentDir,
    projectDir,
    homeDirOverride,
    skillsHome,
    isSafeDocName,
    commentService,
    enumerateInstalledSkillsCached,
    checkLocalOpSecurity,
  } = deps;

  /**
   * Read-only cross-harness installed-skill enumeration. `GET /api/skills/installed`
   * returns `{ skills, packs }` — every skill OK can see across all harness
   * homes (Claude plugins + the bare skill dirs), normalized + de-duped. Pure
   * read: no home is mutated (NOT in MUTATING_ROUTES). 200 with empty arrays on
   * a machine with nothing installed.
   */
  const handleSkillsInstalled = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      try {
        // The catalog is machine-global; the detected sidebar shows it under the
        // OPEN project's scopes. Two moves keep it faithful to the project |
        // global invariant (precedent #50): (1) resolve a linked worktree to its
        // parent-checkout identity so the parent's project-scoped installs
        // (keyed on the parent path) still match here; (2) ALSO scan this
        // project's `.<harness>/skills` dirs so every harness's project skills
        // surface, not just Claude plugins. The SAME identity is used to scan,
        // stamp, and filter — drop skills bound to a *different* project.
        const identity = resolveProjectIdentity(projectDir ?? contentDir);
        // Same `homeDirOverride` seam as every other home-scanning surface here —
        // without it a rig (or embedded host) enumerates the REAL ~/.claude/plugins.
        const catalog = enumerateInstalledSkillsCached({
          projectDir: identity,
          ...(homeDirOverride !== undefined ? { home: homeDirOverride } : {}),
        });
        // In-place editor-dir skills are first-class `/api/skills`
        // entries at BOTH scopes — dropping them here keeps the same skill from
        // double-listing as a "detected" row. What remains detected: plugin-cache
        // skills (`~/.claude/plugins/**`), which the in-place scans don't cover.
        const inPlaceNames = new Set(scanInPlaceSkills(contentDir).map((s) => s.name));
        const globalInPlaceNames = new Set(scanGlobalInPlaceSkills(skillsHome).map((s) => s.name));
        const result = {
          ...catalog,
          skills: catalog.skills
            .filter(
              (s) =>
                isDetectedSkillInProject(s.provenance, identity) &&
                !(s.provenance.scope === 'project'
                  ? inPlaceNames.has(s.name)
                  : globalInPlaceNames.has(s.name)),
            )
            // `identity` is the PARENT checkout for a linked worktree, so a skill
            // can match the project while living in a tree the user does not have
            // open. Stamp that so the client can refuse an in-place edit that would
            // land in another checkout on another branch.
            //
            // The reference is the OPEN PROJECT ROOT — `projectDir ?? contentDir`,
            // the same expression `identity` is derived from but WITHOUT the
            // worktree→parent resolution. Not `identity` (that resolution makes the
            // test vacuously false), and not `contentDir`: under `content.dir: docs`
            // contentDir is `<projectDir>/docs` while harness skill dirs sit at
            // `<projectDir>/.codex/skills/…`, so every project skill in the user's
            // OWN checkout would be flagged foreign.
            .map((s) =>
              isSkillOutsideOpenProject(s.provenance, s.home, projectDir ?? contentDir)
                ? { ...s, outsideProject: true }
                : s,
            ),
        };
        successResponse(res, 200, SkillsInstalledSuccessSchema, result, {
          handler: 'skills-installed',
        });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to enumerate installed skills.',
          { handler: 'skills-installed', cause: e },
        );
      }
    },
    { handler: 'skills-installed', method: 'GET', skipBodyParse: true },
  );

  /**
   * Bulk unresolved-comment-count lookup, the read-side counterpart to
   * `/api/backlink-counts`. `GET /api/comment-counts?docNames=a,b,c` returns
   * `{ counts: { a: 2, b: 0 } }`; `?prefix=folder` returns the same shape for
   * every doc under that folder that carries threads (sparse — a comment-free
   * subtree yields `{}`), which is how an `ls` entry gets a folder rollup
   * without a request per file.
   *
   * Read-only, so it stays out of `MUTATING_ROUTES` — unlike `/api/comments`,
   * whose POST creates threads. docNames failing `isSafeDocName` are silently
   * dropped, matching backlink-counts; a malformed `prefix` is a 400 because
   * dropping it would silently widen the query to the whole project.
   */
  const handleCommentCounts = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const prefix = url.searchParams.get('prefix');
        const raw = url.searchParams.get('docNames');
        if (prefix === null && raw === null) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Missing docNames or prefix parameter.',
            { handler: 'comment-counts' },
          );
          return;
        }
        let counts: Record<string, number> = {};
        if (prefix !== null) {
          const trimmed = prefix.trim();
          if (trimmed !== '' && !isSafeDocName(trimmed)) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid prefix parameter.', {
              handler: 'comment-counts',
            });
            return;
          }
          counts = Object.fromEntries(await commentService.countThreads({ prefix: trimmed }));
        } else {
          const docNames = (raw ?? '')
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name !== '' && isSafeDocName(name));
          counts = Object.fromEntries(await commentService.countThreads({ docNames }));
        }
        successResponse(
          res,
          200,
          CommentCountsSuccessSchema,
          { counts },
          {
            handler: 'comment-counts',
          },
        );
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to read comment counts.',
          { handler: 'comment-counts', cause: e },
        );
      }
    },
    { handler: 'comment-counts', method: 'GET', skipBodyParse: true },
  );

  /**
   * Project-wide flat enumeration of every `<folder>/.ok/templates/*.md`.
   * The single-template `/api/template` endpoint is per-folder + walks
   * leaf → root for closest-wins resolution; this surface is the editor's
   * empty-state list (every template the user can pick from, with the
   * `source_folder` that owns each one). Skips the same dirs as the
   * directory-scan walker — see `resolveProjectTemplates`.
   */
  const handleTemplatesList = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const resolvedContentDir = resolve(contentDir);
        const result = await resolveProjectTemplates(resolvedContentDir);
        // Drop `scope` from each entry — every flat-enumeration entry is
        // implicitly `scope: 'local'` to its own `source_folder`, so the
        // field carries no information here. `TemplatesListEntrySchema` is
        // `.strict()` and would otherwise reject the response.
        const templates = result.templates.map((t) => {
          const { scope: _scope, ...rest } = t;
          return rest;
        });
        successResponse(
          res,
          200,
          TemplatesListSuccessSchema,
          { templates, truncated: result.truncated },
          { handler: 'templates-list' },
        );
      },
      { handler: 'templates-list', title: 'Failed to list templates.' },
    ),
    { handler: 'templates-list', method: 'GET', skipBodyParse: true },
  );

  const handleSkillInstallState = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const snapshot = await readSkillInstallStateSnapshot(homedir());
        successResponse(
          res,
          200,
          SkillInstallStateSuccessSchema,
          { ...snapshot },
          {
            handler: 'skill-install-state',
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      },
      { handler: 'skill-install-state', title: 'Failed to read skill install state.' },
    ),
    {
      handler: 'skill-install-state',
      method: 'GET',
      skipBodyParse: true,
      preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: 'skill-install-state' }),
    },
  );

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
    '/api/comment-counts': handleCommentCounts,
    '/api/skills/installed': handleSkillsInstalled,
    '/api/templates': handleTemplatesList,
    '/api/skill/install-state': handleSkillInstallState,
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
    // effects. Every route here is a read and none rode that gate.
    // `skill/install-state` enforces its loopback + DNS-rebinding refusal via
    // the `checkLocalOpSecurity` pre-body gate, not the mutating gate.
    isMutating: () => false,
  };

  return {
    paths: Object.keys(routes),
    table,
  };
}
