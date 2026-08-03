/**
 * The six skills.sh discovery handlers, lifted out of `api-extension.ts`.
 *
 * Stateless proxy and cache reads: no `session`, no `dc`, no `transact`. What
 * they closed over in the extension arrives as {@link SkillsShHandlerDeps} so
 * the route table keeps referencing them by name.
 *
 * `resolveSkillDirForRead` is passed in rather than imported because it is a
 * closure local of the extension. The factory call therefore has to sit AFTER
 * `skillsHome` is initialized (it is a `const`, so an earlier call would hit its
 * temporal dead zone); it lives immediately above the route table.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, sep } from 'node:path';
import type { SkillRefResolution } from '@inkeep/open-knowledge-core';
import {
  EmptyRequestSchema,
  SKILL_NAME_REGEX,
  SkillDetailSchema,
  SkillDiscoverSchema,
  SkillPreviewSchema,
  SkillRefResolutionSchema,
  SkillsSearchSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  acquiredBundleTooLarge,
  discoverSkillDirs,
  discoverWellKnownSkills,
  fetchSource,
  inspectPluginBundleDir,
  inspectPluginSource,
  parseGitHubRepoSearch,
  parseOpenGraph,
  parseSkillDir,
  parseSkillsShSearch,
  parseSkillsShWebsiteSource,
  parseSource,
  readSkillDirMeta,
  resolveSkillsShImportSource,
  SKILLS_LOCK_REL,
  SkillFetchError,
  skillsShSkillLinks,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { errorResponse } from './http/error-response.ts';
import { withValidation } from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import { isAllowedGitUrl } from './local-op-security.ts';
import type { PinoLogger } from './logger.ts';
import { rejectDisallowedGitSpec } from './skill-git-spec-guard.ts';
import { getPopularSkills } from './skills-leaderboard.ts';
import { readSkillsLockFile } from './skills-lock-store.ts';

export interface SkillsShHandlerDeps {
  log: PinoLogger;
  skillsHome: string;
  projectDir: string | undefined;
  contentDir: string;
  resolveSkillDirForRead: (
    scope: 'project' | 'global',
    name: string,
    host?: string,
  ) => string | null;
}

export type SkillsShHandlers = Record<
  | 'handleSkillsSearch'
  | 'handleSkillsPopular'
  | 'handleSkillsDetail'
  | 'handleSkillsPreview'
  | 'handleSkillsDiscover'
  | 'handleSkillsResolveRef',
  (req: IncomingMessage, res: ServerResponse) => Promise<void>
>;

export function createSkillsShHandlers(deps: SkillsShHandlerDeps): SkillsShHandlers {
  const { log, skillsHome, projectDir, contentDir, resolveSkillDirForRead } = deps;

  // `GET /api/skills/search?q=<query>` — proxy skill discovery. Primary backend is
  // the keyless skills.sh endpoint its own CLI uses (undocumented, so we
  // defensive-parse and fall back to GitHub-topic search on error or shape drift).
  // The GitHub fallback is degraded (repo-level, no install-count ranking); the
  // response's `backend`/`degraded` let the client drop the install-count sort.
  const handleSkillsSearch = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (q.length < 2) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'Search query must be at least 2 characters.',
          { handler: 'skills-search' },
        );
        return;
      }
      try {
        const r = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=30`, {
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const results = parseSkillsShSearch(await r.json());
          successResponse(
            res,
            200,
            SkillsSearchSuccessSchema,
            { results, backend: 'skills.sh', degraded: false },
            { handler: 'skills-search' },
          );
          return;
        }
        log.warn(
          { status: r.status },
          'skills.sh search unavailable — falling back to GitHub topic search',
        );
      } catch (e) {
        log.warn({ err: e }, 'skills.sh search failed — falling back to GitHub topic search');
      }
      try {
        const ghQ = encodeURIComponent(`${q} topic:agent-skills`);
        const gh = await fetch(`https://api.github.com/search/repositories?q=${ghQ}&per_page=30`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!gh.ok) {
          // 403 (unauthenticated rate cap) / 429 are the common cases. Reporting
          // these as an empty result set told the user "No skills found" — that
          // the skill does not exist — when both backends were simply refusing
          // to answer. Take the same exit as the outer catch so the client says
          // the search failed instead.
          log.warn({ status: gh.status }, 'GitHub skill search fallback returned non-ok');
          errorResponse(
            res,
            502,
            'urn:ok:error:internal-server-error',
            'Skill discovery is temporarily unavailable.',
            { handler: 'skills-search', detail: `GitHub fallback returned ${gh.status}.` },
          );
          return;
        }
        const results = parseGitHubRepoSearch(await gh.json());
        successResponse(
          res,
          200,
          SkillsSearchSuccessSchema,
          { results, backend: 'github-fallback', degraded: true },
          { handler: 'skills-search' },
        );
      } catch (e) {
        errorResponse(
          res,
          502,
          'urn:ok:error:internal-server-error',
          'Skill discovery is temporarily unavailable.',
          { handler: 'skills-search', cause: e },
        );
      }
    },
    { handler: 'skills-search', method: 'GET', skipBodyParse: true },
  );

  // `GET /api/skills/popular?limit=<n>` — the Discover blank-state list. No keyless
  // leaderboard endpoint exists (token-gated), so the server scrapes the skills.sh
  // front-page RSC payload, cached + best-effort (see `getPopularSkills`). An empty
  // list (backend degraded) tells the client to fall back to topic chips.
  const handleSkillsPopular = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 60) : 24;
      // `getPopularSkills` is best-effort (swallows fetch/parse failures and
      // returns []), but guard the wire boundary anyway — the sibling
      // `handleSkillsSearch` does the same, and it keeps the handler correct if
      // the leaderboard helper's contract ever changes to throw.
      try {
        const results = await getPopularSkills(limit);
        successResponse(
          res,
          200,
          SkillsSearchSuccessSchema,
          { results, backend: 'skills.sh', degraded: results.length === 0 },
          { handler: 'skills-popular' },
        );
      } catch (e) {
        errorResponse(
          res,
          502,
          'urn:ok:error:internal-server-error',
          'Popular skills are temporarily unavailable.',
          { handler: 'skills-popular', cause: e },
        );
      }
    },
    { handler: 'skills-popular', method: 'GET', skipBodyParse: true },
  );

  // `GET /api/skills/detail?source=&name=` — enrich one discovery result for the
  // info modal. The shared catalog-source parser owns both GitHub and website
  // route shapes. The rich preview comes from the skills.sh page's Open Graph
  // tags because the page itself cannot be iframed (`x-frame-options: DENY`).
  const handleSkillsDetail = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const source = url.searchParams.get('source')?.trim() ?? '';
      const name = url.searchParams.get('name')?.trim() ?? '';
      if (!source || !name) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'source and name are required.', {
          handler: 'skills-detail',
        });
        return;
      }
      const links = skillsShSkillLinks(source, name);
      if (!links) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unrecognized skill source.', {
          handler: 'skills-detail',
        });
        return;
      }
      const { skillsUrl, sourceKind, sourceUrl } = links;
      let og: { title?: string; description?: string; image?: string } = {};
      let pageReached = false;
      try {
        const r = await fetch(skillsUrl, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          pageReached = true;
          og = parseOpenGraph(await r.text());
        }
      } catch (e) {
        log.warn({ err: e, skillsUrl }, 'skills.sh detail fetch failed — degrading to repo link');
      }
      successResponse(
        res,
        200,
        SkillDetailSchema,
        {
          title: og.title ?? name,
          description: og.description ?? '',
          image: og.image ?? null,
          skillsUrl: pageReached ? skillsUrl : null,
          sourceKind,
          sourceUrl,
        },
        { handler: 'skills-detail' },
      );
    },
    { handler: 'skills-detail', method: 'GET', skipBodyParse: true },
  );

  // `GET /api/skills/preview?source=&name=` fetches one un-imported bundle so
  // Explore can render the exact files before installation. Repository and
  // website sources converge on the same temporary-directory parser here.
  // ponytail: remote sources are fetched per preview open; add a short-lived
  // cache keyed on source+ref if click-through churn becomes a problem.
  const handleSkillsPreview = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const source = url.searchParams.get('source')?.trim() ?? '';
      const name = url.searchParams.get('name')?.trim() ?? '';
      if (!source) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'source is required.', {
          handler: 'skills-preview',
        });
        return;
      }
      let resolvedSkillsSh: Awaited<ReturnType<typeof resolveSkillsShImportSource>> = null;
      try {
        resolvedSkillsSh = await resolveSkillsShImportSource(source, name || undefined);
      } catch (error) {
        if (error instanceof SkillFetchError) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not resolve source.', {
            handler: 'skills-preview',
            cause: error,
          });
          return;
        }
        throw error;
      }
      const spec = resolvedSkillsSh?.spec ?? parseSource(source);
      if (!spec) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unrecognized preview source.', {
          handler: 'skills-preview',
          detail: 'Expected owner/repo, a git URL, a website source, or a local path.',
        });
        return;
      }
      if (rejectDisallowedGitSpec(res, spec, 'skills-preview')) return;
      let cleanup: (() => void) | undefined;
      try {
        const fetched = await fetchSource(spec);
        cleanup = fetched.cleanup;
        const dirs = discoverSkillDirs(fetched.dir);
        if (dirs.length === 0) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
            handler: 'skills-preview',
          });
          return;
        }
        // Match the search row's name against the dir basename OR the SKILL.md
        // frontmatter name (they often differ). A named MISS is a 404 here for
        // the same reason it is one on import: this is the consent surface. The
        // old fallback to `dirs[0]` rendered a different skill's prose under the
        // requested name — the header still said "a preview of <name>" and the
        // properties block still showed `<name>` — and then import refused the
        // same miss, so the user read one skill and could only install another.
        let pick = dirs[0];
        if (name) {
          const found =
            dirs.find((d) => d.name === name) ??
            dirs.find((d) => readSkillDirMeta(d.dir)?.name === name);
          if (!found) {
            errorResponse(res, 404, 'urn:ok:error:not-found', 'Named skill not in source.', {
              handler: 'skills-preview',
              detail: `"${name}" not among: ${dirs.map((d) => d.name).join(', ')}.`,
            });
            return;
          }
          pick = found;
        }
        const tooLarge = acquiredBundleTooLarge(pick.dir);
        if (tooLarge) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Skill bundle is too large.', {
            handler: 'skills-preview',
            detail: tooLarge,
          });
          return;
        }
        const parsed = parseSkillDir(pick.dir);
        if (!parsed) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'SKILL.md unreadable in source.', {
            handler: 'skills-preview',
          });
          return;
        }
        const plugin = inspectPluginSource(source);
        // The skills.sh source repo may itself be a plugin bundling several
        // skills — skills.sh never flags that, but the clone carries the
        // manifest and we already have it in hand (`fetched.dir`). Read-only.
        const pluginBundle = inspectPluginBundleDir(fetched.dir);
        successResponse(
          res,
          200,
          SkillPreviewSchema,
          {
            name: parsed.name,
            description: parsed.description,
            skillMd: parsed.skillMd,
            // Strip raw `bytes` (binary files) — a preview renders text or shows
            // the file as binary (`content: null`); the bytes are not JSON-safe
            // and only matter on import.
            files: parsed.files.map((f) => ({ relPath: f.relPath, content: f.content })),
            plugin: plugin ?? undefined,
            pluginBundle: pluginBundle ?? undefined,
          },
          { handler: 'skills-preview' },
        );
      } catch (e) {
        if (e instanceof SkillFetchError) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
            handler: 'skills-preview',
            cause: e,
          });
          return;
        }
        errorResponse(res, 502, 'urn:ok:error:internal-server-error', 'Preview is unavailable.', {
          handler: 'skills-preview',
          cause: e,
        });
      } finally {
        cleanup?.();
      }
    },
    { handler: 'skills-preview', method: 'GET', skipBodyParse: true },
  );

  // `GET /api/skills/discover?source=` enumerates a repository/local tree or a
  // website's well-known index so the Import modal can offer an exact picker.
  // ponytail: remote indexes/repos are fetched per call; cache by source+ref if
  // debounced typing churn becomes a problem.
  const handleSkillsDiscover = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const source = url.searchParams.get('source')?.trim() ?? '';
      if (!source) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'source is required.', {
          handler: 'skills-discover',
        });
        return;
      }
      const websiteSource = parseSkillsShWebsiteSource(source);
      if (websiteSource) {
        try {
          const skills = await discoverWellKnownSkills(`https://${websiteSource.hostname}`);
          successResponse(
            res,
            200,
            SkillDiscoverSchema,
            { skills },
            { handler: 'skills-discover' },
          );
        } catch (error) {
          if (error instanceof SkillFetchError) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
              handler: 'skills-discover',
              cause: error,
            });
            return;
          }
          throw error;
        }
        return;
      }
      const spec = parseSource(source);
      if (!spec) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unrecognized source.', {
          handler: 'skills-discover',
          detail: 'Expected owner/repo, a git URL, a website source, or a local path.',
        });
        return;
      }
      if (rejectDisallowedGitSpec(res, spec, 'skills-discover')) return;
      let cleanup: (() => void) | undefined;
      try {
        const fetched = await fetchSource(spec);
        cleanup = fetched.cleanup;
        const dirs = discoverSkillDirs(fetched.dir);
        // Prefer the SKILL.md frontmatter name (what the import path matches and
        // what a user recognizes); fall back to the dir basename.
        const skills = dirs.map((d) => {
          // Metadata-only: a listing has no use for bundle bytes, and reading
          // them for every skill in a large repo is how a preview turns into an
          // out-of-memory kill.
          const meta = readSkillDirMeta(d.dir);
          return { name: meta?.name ?? d.name, description: meta?.description ?? null };
        });
        successResponse(res, 200, SkillDiscoverSchema, { skills }, { handler: 'skills-discover' });
      } catch (e) {
        if (e instanceof SkillFetchError) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
            handler: 'skills-discover',
            cause: e,
          });
          return;
        }
        errorResponse(res, 502, 'urn:ok:error:internal-server-error', 'Discovery is unavailable.', {
          handler: 'skills-discover',
          cause: e,
        });
      } finally {
        cleanup?.();
      }
    },
    { handler: 'skills-discover', method: 'GET', skipBodyParse: true },
  );

  // `GET /api/skills/resolve-ref?ref=<name>&scope=<scope>&from=<skill>` — resolve
  // a skill's `/other-skill` reference by TRUSTED-PROVENANCE precedence, never a
  // marketplace-wide name search (that would import a stranger's same-name skill
  // thinking it's the dependency). Ladder: (1) already installed → local; (2) a
  // sibling in the referencing skill's own origin repo/plugin → import via
  // source; (3) a same-publisher skills.sh result with the exact name → import
  // via publisher; else none, and the caller offers MANUAL Explore search.
  const handleSkillsResolveRef = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const ref = url.searchParams.get('ref')?.trim() ?? '';
      const from = url.searchParams.get('from')?.trim() ?? '';
      const scope = url.searchParams.get('scope')?.trim() === 'global' ? 'global' : 'project';
      if (!ref || !SKILL_NAME_REGEX.test(ref) || ref.length > 64) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'A valid ref is required.', {
          handler: 'skills-resolve-ref',
        });
        return;
      }
      // Top-level guard like every sibling skills handler: `readSkillsLockFile`
      // (existsSync → readFileSync) can throw on EACCES / a TOCTOU race, and an
      // unguarded throw would surface as a context-less 500 from the outer
      // catch.
      try {
        const respond = (resolution: SkillRefResolution) =>
          successResponse(res, 200, SkillRefResolutionSchema, resolution, {
            handler: 'skills-resolve-ref',
          });

        // 1. LOCAL — same scope first, then the other. Already-present wins: it's
        // what the user chose to have, and importing a same-name skill would fork.
        for (const s of [scope, scope === 'project' ? 'global' : 'project'] as const) {
          const realDir = resolveSkillDirForRead(s, ref);
          if (realDir !== null) {
            // Return the REAL dir, not just the name: the caller opens this skill,
            // and deriving the doc name from the name alone assumes the retired
            // store layout.
            respond({
              kind: 'local',
              scope: s,
              name: ref,
              dir: relative(s === 'project' ? contentDir : skillsHome, realDir)
                .split(sep)
                .join('/'),
            });
            return;
          }
        }

        // Referencing skill's provenance from its scope lockfile (import origin).
        const lockBase = scope === 'project' ? projectDir : skillsHome;
        const entry =
          from && lockBase
            ? readSkillsLockFile(join(lockBase, ...SKILLS_LOCK_REL)).skills[from]
            : undefined;

        // 2. SAME SOURCE — a sibling in the referencing skill's own repo/plugin.
        // (A plugin's siblings resolve here too: its source is the plugin dir.)
        if (entry?.source) {
          const resolvedSkillsSh = await resolveSkillsShImportSource(entry.source, ref);
          const spec = resolvedSkillsSh?.spec ?? parseSource(entry.source);
          const allowed = spec && !(spec.kind === 'git' && !isAllowedGitUrl(spec.url));
          if (spec && allowed) {
            let cleanup: (() => void) | undefined;
            try {
              const fetched = await fetchSource(spec);
              cleanup = fetched.cleanup;
              const names = discoverSkillDirs(fetched.dir).map(
                (d) => readSkillDirMeta(d.dir)?.name ?? d.name,
              );
              if (names.includes(ref)) {
                respond({ kind: 'import', source: entry.source, ref, via: 'source' });
                return;
              }
            } catch (err) {
              // Source unreachable (clone failure / bad source) — fall through to
              // the publisher rung, but leave a trail so a stale/deleted origin
              // repo doesn't degrade ref resolution silently.
              log.debug(
                { err, ref, from, source: entry.source },
                'resolve-ref: source rung unreachable, falling through to publisher',
              );
            } finally {
              cleanup?.();
            }
          }
        }

        // 3. SAME PUBLISHER — a same-publisher skills.sh result with the EXACT name.
        // Constrained (publisher + exact name), not a fuzzy match; a unique hit only.
        if (entry?.publisher) {
          try {
            const r = await fetch(
              `https://skills.sh/api/search?q=${encodeURIComponent(ref)}&limit=30`,
              { signal: AbortSignal.timeout(8000) },
            );
            if (r.ok) {
              const matches = parseSkillsShSearch(await r.json()).filter(
                (x) => x.name === ref && x.publisher === entry.publisher,
              );
              if (matches.length === 1) {
                const match = matches[0];
                if (match) {
                  respond({ kind: 'import', source: match.source, ref, via: 'publisher' });
                  return;
                }
              }
            }
          } catch (err) {
            // skills.sh unreachable or a malformed (e.g. HTML during an outage)
            // response — no publisher resolution this call. Log so an outage is
            // distinguishable from "skill genuinely absent from this publisher".
            log.debug(
              { err, ref, publisher: entry.publisher },
              'resolve-ref: skills.sh unavailable, no publisher resolution',
            );
          }
        }

        // 4. NONE — no trusted signal. The caller keeps the missing-ref marker
        // and offers manual Explore search; OK never auto-picks a fuzzy match.
        respond({ kind: 'none' });
      } catch (err) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Could not resolve the reference.',
          {
            handler: 'skills-resolve-ref',
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        );
      }
    },
    { handler: 'skills-resolve-ref', method: 'GET', skipBodyParse: true },
  );

  return {
    handleSkillsSearch,
    handleSkillsPopular,
    handleSkillsDetail,
    handleSkillsPreview,
    handleSkillsDiscover,
    handleSkillsResolveRef,
  };
}
