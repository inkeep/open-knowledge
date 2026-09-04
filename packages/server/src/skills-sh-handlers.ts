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
import { fetchCachedSource } from './skill-source-cache.ts';
import { getPopularSkills, getPublisherSkills } from './skills-leaderboard.ts';
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
  | 'handleSkillsPublisher'
  | 'handleSkillsDetail'
  | 'handleSkillsPreview'
  | 'handleSkillsDiscover'
  | 'handleSkillsResolveRef',
  (req: IncomingMessage, res: ServerResponse) => Promise<void>
>;

export function createSkillsShHandlers(deps: SkillsShHandlerDeps): SkillsShHandlers {
  const { log, skillsHome, projectDir, contentDir, resolveSkillDirForRead } = deps;

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

  const handleSkillsPopular = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 60) : 24;
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

  const handleSkillsPublisher = withValidation(
    EmptyRequestSchema,
    async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const source = url.searchParams.get('source')?.trim() ?? '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(source) || source.includes('..')) {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'source must be owner/repo.', {
          handler: 'skills-publisher',
        });
        return;
      }
      try {
        const results = await getPublisherSkills(source);
        successResponse(
          res,
          200,
          SkillsSearchSuccessSchema,
          { results, backend: 'skills.sh', degraded: results.length === 0 },
          { handler: 'skills-publisher' },
        );
      } catch (e) {
        errorResponse(
          res,
          502,
          'urn:ok:error:internal-server-error',
          'Publisher skills are temporarily unavailable.',
          { handler: 'skills-publisher', cause: e },
        );
      }
    },
    { handler: 'skills-publisher', method: 'GET', skipBodyParse: true },
  );

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
      try {
        const fetched = await fetchCachedSource(spec);
        const dirs = discoverSkillDirs(fetched.dir);
        if (dirs.length === 0) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'No SKILL.md found in source.', {
            handler: 'skills-preview',
          });
          return;
        }
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
        const pluginBundle = inspectPluginBundleDir(fetched.dir);
        successResponse(
          res,
          200,
          SkillPreviewSchema,
          {
            name: parsed.name,
            description: parsed.description,
            skillMd: parsed.skillMd,
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
      }
    },
    { handler: 'skills-preview', method: 'GET', skipBodyParse: true },
  );

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
      try {
        const fetched = await fetchCachedSource(spec);
        const dirs = discoverSkillDirs(fetched.dir);
        const skills = dirs.map((d) => {
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
      }
    },
    { handler: 'skills-discover', method: 'GET', skipBodyParse: true },
  );

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
      try {
        const respond = (resolution: SkillRefResolution) =>
          successResponse(res, 200, SkillRefResolutionSchema, resolution, {
            handler: 'skills-resolve-ref',
          });

        for (const s of [scope, scope === 'project' ? 'global' : 'project'] as const) {
          const realDir = resolveSkillDirForRead(s, ref);
          if (realDir !== null) {
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

        const lockBase = scope === 'project' ? projectDir : skillsHome;
        const entry =
          from && lockBase
            ? readSkillsLockFile(join(lockBase, ...SKILLS_LOCK_REL)).skills[from]
            : undefined;

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
              log.debug(
                { err, ref, from, source: entry.source },
                'resolve-ref: source rung unreachable, falling through to publisher',
              );
            } finally {
              cleanup?.();
            }
          }
        }

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
            log.debug(
              { err, ref, publisher: entry.publisher },
              'resolve-ref: skills.sh unavailable, no publisher resolution',
            );
          }
        }

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
    handleSkillsPublisher,
    handleSkillsDetail,
    handleSkillsPreview,
    handleSkillsDiscover,
    handleSkillsResolveRef,
  };
}
