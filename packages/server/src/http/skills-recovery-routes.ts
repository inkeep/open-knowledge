import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import {
  type Principal,
  RENAMED_PACK_SKILLS,
  type SkillReimportBulkResult,
  SkillReimportRequestSchema,
  SkillReimportSuccessSchema,
  SkillRestoreRequestSchema,
  SkillRestoreSuccessSchema,
  SkillRevertRequestSchema,
  SkillRevertSuccessSchema,
  SkillsReimportBulkRequestSchema,
  SkillsReimportBulkSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  discoverSkillDirs,
  fetchSource,
  parseSkillDir,
  parseSource,
  resolvePluginUpdateSource,
  resolveSkillsShImportSource,
  retrofitPackLockEntry,
  SKILLS_LOCK_REL,
  SkillFetchError,
  type SkillsLock,
  upsertLockEntry,
} from '@inkeep/open-knowledge-core/skills-catalog';
import type { ContentFilter } from '../content-filter.ts';
import { extractActorIdentity } from '../extract-actor-identity.ts';
import { scanGlobalInPlaceSkills, scanInPlaceSkills } from '../in-place-skills.ts';
import { getLogger } from '../logger.ts';
import type { SkillReimportDeps, SkillReimportService } from '../services/skill-reimport.ts';
import {
  groupReimportNamesBySource,
  pickReimportDir,
  type SkillReimportOutcome,
} from '../services/skill-reimport.ts';
import type { ShadowRef } from '../shadow-repo.ts';
import { isDisallowedGitSpec, rejectDisallowedGitSpec } from '../skill-git-spec-guard.ts';
import { validateSkillForInstall } from '../skill-projection.ts';
import { restoreSkillVersion } from '../skill-restore.ts';
import { mutateSkillsLock, readSkillsLockFile } from '../skills-lock-store.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { getRequestId } from './request-id.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

function bundleSelfIdentifiesAsPack(dir: string): boolean {
  try {
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md)?.[1];
    return (
      frontmatter !== undefined && /^[ \t]+pack:[ \t]*"?[a-z0-9-]+"?[ \t]*$/m.test(frontmatter)
    );
  } catch {
    return false;
  }
}

export interface SkillsRecoveryRouteDeps {
  synthPluginLockEntry: (
    name: string,
    identity: string,
    skillAbsDir?: string,
  ) => SkillsLock['skills'][string] | null;
  synthBuiltinLockEntry: (
    base: string,
    name: string,
    scope: 'project' | 'global',
  ) => SkillsLock['skills'][string] | null;
  isValidSkillName: (name: string) => boolean;
  getPrincipal: (() => Principal | null) | undefined;
  validateSkillName: (name: string, res: ServerResponse, handler: string) => boolean;
  rejectReservedBuiltinSkill: (name: string, res: ServerResponse, handler: string) => boolean;
  shadowRef: ShadowRef | undefined;
  contentDir: string;
  contentRoot: string | undefined;
  projectDir: string | undefined;
  skillsHome: string;
  projectSkillDirRel: (name: string) => string;
  attributeOkArtifactWrite: SkillReimportDeps['attributeOkArtifactWrite'];
  okArtifactKey: (
    kind: 'template' | 'folder-frontmatter' | 'folder' | 'skill',
    folder: string,
    name?: string,
  ) => string;
  commitOkArtifactWrite: SkillReimportDeps['commitOkArtifactWrite'];
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  bumpSkillsCatalogGen: () => void;
  contentFilter: ContentFilter | undefined;
  scheduleDeferredIgnoreRebuild: () => void;
  effectiveSkillRoot: SkillReimportDeps['effectiveSkillRoot'];
  skillReimportService: SkillReimportService;
  localSkillHash: (skillsRoot: string, name: string) => string | undefined;
  resolveSkillsRoot: (scope: 'project' | 'global') => string;
  projectImportedSkillCopy: SkillReimportDeps['projectImportedSkillCopy'];
}
export function createSkillsRecoveryRoutes(deps: SkillsRecoveryRouteDeps): ApiRouteGroup {
  const {
    synthPluginLockEntry,
    synthBuiltinLockEntry,
    isValidSkillName,
    getPrincipal,
    validateSkillName,
    rejectReservedBuiltinSkill,
    shadowRef,
    contentDir,
    contentRoot,
    projectDir,
    skillsHome,
    projectSkillDirRel,
    attributeOkArtifactWrite,
    okArtifactKey,
    commitOkArtifactWrite,
    signalChannel,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    effectiveSkillRoot,
    skillReimportService,
    localSkillHash,
    resolveSkillsRoot,
    projectImportedSkillCopy,
  } = deps;
  function respondSkillRestoreFailure(
    res: ServerResponse,
    result: {
      code: 'no-shadow' | 'version-not-found' | 'skill-absent' | 'io-error' | 'path-escape';
      error: string;
    },
    handler: 'skill-restore' | 'skill-revert',
  ): void {
    const map = {
      'no-shadow': [409, 'urn:ok:error:shadow-not-configured'],
      'version-not-found': [404, 'urn:ok:error:not-found'],
      'skill-absent': [404, 'urn:ok:error:not-found'],
      'io-error': [500, 'urn:ok:error:storage-error'],
      'path-escape': [500, 'urn:ok:error:path-escape'],
    } as const;
    const [status, typeUri] = map[result.code];
    errorResponse(res, status, typeUri, result.error, { handler, detail: result.code });
  }

  function respondSkillReimport(res: ServerResponse, outcome: SkillReimportOutcome): void {
    if (outcome.ok) {
      successResponse(res, 200, SkillReimportSuccessSchema, outcome.body, {
        handler: 'skill-reimport',
      });
      return;
    }
    errorResponse(res, outcome.status, outcome.urn, outcome.title, {
      handler: 'skill-reimport',
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
    });
  }

  function packBundleDir(scope: 'project' | 'global', name: string, skillsRoot: string): string {
    const base = scope === 'project' ? contentDir : skillsHome;
    const found = (
      scope === 'project' ? scanInPlaceSkills(contentDir) : scanGlobalInPlaceSkills(skillsHome)
    ).find((s) => s.name === name);
    return found ? resolve(base, found.dir) : resolve(skillsRoot, name);
  }

  function resolveReimportLockEntry(
    scope: 'project' | 'global',
    name: string,
    skillsRoot: string,
    lock: SkillsLock,
  ): SkillsLock['skills'][string] | null {
    const recorded = lock.skills[name];
    if (recorded) return recorded;
    const bundleDir = packBundleDir(scope, name, skillsRoot);
    return (
      retrofitPackLockEntry(
        name,
        parseSkillDir(bundleDir)?.contentHash ?? '',
        new Date().toISOString(),
        { selfIdentifiesAsPack: bundleSelfIdentifiesAsPack(bundleDir) },
      ) ??
      synthBuiltinLockEntry(scope === 'global' ? skillsHome : contentDir, name, scope) ??
      synthPluginLockEntry(name, resolveProjectIdentity(projectDir ?? contentDir), bundleDir)
    );
  }

  const handleSkillRestore = withValidation(
    SkillRestoreRequestSchema,
    async (_req, res, body) => {
      try {
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-restore',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-restore')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-restore')) return;
        if (body.scope === 'global') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Global skills are unversioned — there is no version history to restore from.',
            { handler: 'skill-restore', detail: 'GLOBAL_SCOPE_UNVERSIONED' },
          );
          return;
        }

        const shadow = shadowRef?.current;
        if (!shadow) {
          errorResponse(
            res,
            409,
            'urn:ok:error:shadow-not-configured',
            'No version history available to restore from.',
            {
              handler: 'skill-restore',
              detail: 'NO_SHADOW_REPO',
            },
          );
          return;
        }
        const result = await restoreSkillVersion({
          shadow,
          contentDir,
          contentRoot: contentRoot ?? '.',
          name: body.name,
          version: body.version,
          skillDirRel: projectSkillDirRel(body.name),
        });
        if (!result.ok) {
          respondSkillRestoreFailure(res, result, 'skill-restore');
          return;
        }

        const warnings: string[] = [];
        const skillDir = resolve(contentDir, projectSkillDirRel(body.name));
        const validity = validateSkillForInstall(skillDir, body.name);
        if (!validity.ok) {
          warnings.push(
            `Restored, but the skill no longer validates: ${validity.errors.join(' ')}`,
          );
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-restore: ${body.name} @ ${body.version.slice(0, 8)}`,
        );
        await commitOkArtifactWrite('skill-restore');
        signalChannel?.('files');
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

        successResponse(
          res,
          200,
          SkillRestoreSuccessSchema,
          {
            name: body.name,
            version: body.version,
            restoredFiles: result.restoredFiles,
            warnings,
          },
          { handler: 'skill-restore' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to restore skill.', {
          handler: 'skill-restore',
          cause: e,
        });
      }
    },
    { handler: 'skill-restore', method: 'POST' },
  );

  const handleSkillReimport = withValidation(
    SkillReimportRequestSchema,
    async (_req, res, body) => {
      let cleanup: () => void = () => {};
      try {
        if (body.scope === 'project' && !projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-reimport',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-reimport',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-reimport')) return;

        const reimportBase = body.scope === 'global' ? skillsHome : contentDir;
        const {
          root: skillsRoot,
          dirRel: skillDirRel,
          realDir: reimportRealDir,
        } = effectiveSkillRoot(body.scope, body.name);
        if (
          reimportRealDir === null ||
          !existsSync(resolve(reimportBase, skillDirRel, 'SKILL.md'))
        ) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill is not installed.', {
            handler: 'skill-reimport',
            detail: 'SKILL_ABSENT',
          });
          return;
        }

        const lockPath = join(
          body.scope === 'global' ? skillsHome : (projectDir as string),
          ...SKILLS_LOCK_REL,
        );
        const entry = resolveReimportLockEntry(
          body.scope,
          body.name,
          skillsRoot,
          readSkillsLockFile(lockPath),
        );
        if (!entry) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'This skill has no recorded import source to update from.',
            { handler: 'skill-reimport', detail: 'NOT_IMPORTED' },
          );
          return;
        }
        if (body.setAutoUpdate !== undefined) {
          await mutateSkillsLock(lockPath, (current) => ({
            ...current,
            skills: {
              ...current.skills,
              [body.name]: {
                ...(current.skills[body.name] ?? entry),
                autoUpdate: body.setAutoUpdate,
              },
            },
          }));
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();

          successResponse(
            res,
            200,
            SkillReimportSuccessSchema,
            { name: body.name, updated: false, source: entry.source, warnings: [] },
            { handler: 'skill-reimport' },
          );
          return;
        }
        let ref: string | undefined;
        let acquiredDir: string | null = null;
        try {
          const recordedSkill = entry.skill ?? body.name;
          const renamedSkill = RENAMED_PACK_SKILLS[recordedSkill];
          const skillsSh = await resolveSkillsShImportSource(entry.source, recordedSkill).catch(
            async (err: unknown) => {
              if (renamedSkill === undefined) throw err;
              return resolveSkillsShImportSource(entry.source, renamedSkill);
            },
          );
          const resolvedSource =
            skillsSh?.source ?? resolvePluginUpdateSource(entry.source, entry.pluginProvider);
          const resolvedSkill = skillsSh?.skill ?? entry.skill;
          const spec = skillsSh?.spec ?? parseSource(resolvedSource);
          if (!spec) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'The recorded import source is no longer a valid source.',
              { handler: 'skill-reimport', detail: entry.source },
            );
            return;
          }
          if (rejectDisallowedGitSpec(res, spec, 'skill-reimport')) return;
          const fetched = await fetchSource(spec);
          cleanup = fetched.cleanup;
          ref = fetched.ref;
          const dirs = discoverSkillDirs(fetched.dir);
          const pick = pickReimportDir(dirs, {
            ...(resolvedSkill !== undefined ? { recordedSkill: resolvedSkill } : {}),
            localName: body.name,
            frontmatterNameOf: (dir) => parseSkillDir(dir)?.name,
          });
          if (!pick) {
            errorResponse(
              res,
              404,
              'urn:ok:error:not-found',
              'Could not locate this skill in its source anymore.',
              { handler: 'skill-reimport', detail: dirs.map((d) => d.name).join(', ') },
            );
            return;
          }
          acquiredDir = pick.dir;
        } catch (e) {
          if (e instanceof SkillFetchError) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Could not fetch source.', {
              handler: 'skill-reimport',
              cause: e,
            });
            return;
          }
          throw e;
        }
        if (!acquiredDir) {
          errorResponse(res, 422, 'urn:ok:error:invalid-request', 'Source has no readable skill.', {
            handler: 'skill-reimport',
          });
          return;
        }
        const outcome = await skillReimportService.runSkillReimport({
          acquiredDir,
          name: body.name,
          scope: body.scope,
          entry,
          lockPath,
          ref,
          actor,
          ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
        });
        bumpSkillsCatalogGen();
        contentFilter?.refreshInPlaceSkillDirs();
        scheduleDeferredIgnoreRebuild();

        respondSkillReimport(res, outcome);
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to reimport skill.', {
          handler: 'skill-reimport',
          cause: e,
        });
      } finally {
        cleanup();
      }
    },
    { handler: 'skill-reimport', method: 'POST' },
  );

  const handleSkillsReimportBulk = withValidation(
    SkillsReimportBulkRequestSchema,
    async (_req, res, body) => {
      try {
        if (body.scope === 'project' && !projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skills-reimport-bulk',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skills-reimport-bulk',
          });
          return;
        }
        const lockPath = join(
          body.scope === 'global' ? skillsHome : (projectDir as string),
          ...SKILLS_LOCK_REL,
        );
        const lock = readSkillsLockFile(lockPath);
        const results: SkillReimportBulkResult[] = [];
        const named = new Set(body.names);
        const wellFormed = [...named].filter((name) => {
          if (isValidSkillName(name)) return true;
          results.push({ requested: name, status: 'failed', warnings: [], error: 'INVALID_NAME' });
          return false;
        });
        const { bySource, unrecorded } = groupReimportNamesBySource(wellFormed, (name) =>
          resolveReimportLockEntry(
            body.scope,
            name,
            effectiveSkillRoot(body.scope, name).root,
            lock,
          ),
        );
        for (const name of unrecorded) {
          results.push({ requested: name, status: 'not-found', warnings: [] });
        }

        for (const group of bySource) {
          let cleanup: () => void = () => {};
          try {
            let ref: string | undefined;
            let dirs: ReturnType<typeof discoverSkillDirs> = [];
            try {
              const probe = group.names[0] as string;
              const skillsSh = await resolveSkillsShImportSource(group.source, probe).catch(
                async (err: unknown) => {
                  const renamed = RENAMED_PACK_SKILLS[probe];
                  if (renamed === undefined) throw err;
                  return resolveSkillsShImportSource(group.source, renamed);
                },
              );
              const resolvedSource =
                skillsSh?.source ??
                resolvePluginUpdateSource(
                  group.source,
                  lock.skills[group.names[0] as string]?.pluginProvider,
                );
              const spec = skillsSh?.spec ?? parseSource(resolvedSource);
              if (!spec || isDisallowedGitSpec(spec)) {
                for (const name of group.names) {
                  results.push({
                    requested: name,
                    status: 'failed',
                    source: group.source,
                    warnings: [],
                    error: 'INVALID_SOURCE',
                  });
                }
                continue;
              }
              const fetched = await fetchSource(spec);
              cleanup = fetched.cleanup;
              ref = fetched.ref;
              dirs = discoverSkillDirs(fetched.dir);
            } catch (e) {
              getLogger('skills-reimport-bulk').warn(
                { source: group.source, err: e, requestId: getRequestId(_req) },
                'bulk update: one source could not be fetched (rest continue)',
              );
              for (const name of group.names) {
                results.push({
                  requested: name,
                  status: 'failed',
                  source: group.source,
                  warnings: [],
                  error: e instanceof Error ? e.message : String(e),
                });
              }
              continue;
            }
            for (const name of group.names) {
              const entry = resolveReimportLockEntry(
                body.scope,
                name,
                effectiveSkillRoot(body.scope, name).root,
                lock,
              );
              if (!entry) {
                results.push({ requested: name, status: 'not-found', warnings: [] });
                continue;
              }
              const pick = pickReimportDir(dirs, {
                ...(entry.skill !== undefined ? { recordedSkill: entry.skill } : {}),
                localName: name,
                frontmatterNameOf: (dir) => parseSkillDir(dir)?.name,
              });
              if (!pick) {
                results.push({
                  requested: name,
                  status: 'not-found',
                  source: entry.source,
                  warnings: [],
                });
                continue;
              }
              try {
                const outcome = await skillReimportService.runSkillReimport({
                  acquiredDir: pick.dir,
                  name,
                  scope: body.scope,
                  entry,
                  lockPath,
                  ref,
                  actor,
                });
                if (!outcome.ok) {
                  getLogger('skills-reimport-bulk').warn(
                    {
                      skill: name,
                      err: outcome.cause,
                      detail: outcome.detail,
                      requestId: getRequestId(_req),
                    },
                    'bulk update: one skill failed (rest continue)',
                  );
                  results.push({
                    requested: name,
                    status: 'failed',
                    source: entry.source,
                    warnings: [],
                    error: outcome.detail ?? outcome.title,
                  });
                  continue;
                }
                results.push({
                  requested: name,
                  status: outcome.body.updated ? 'updated' : 'up-to-date',
                  source: outcome.body.source,
                  warnings: outcome.body.warnings,
                });
              } catch (e) {
                getLogger('skills-reimport-bulk').warn(
                  { skill: name, err: e, requestId: getRequestId(_req) },
                  'bulk update: one skill threw (rest continue)',
                );
                results.push({
                  requested: name,
                  status: 'failed',
                  source: entry.source,
                  warnings: [],
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          } finally {
            cleanup();
          }
        }
        successResponse(
          res,
          200,
          SkillsReimportBulkSuccessSchema,
          {
            results,
            updated: results.filter((r) => r.status === 'updated').length,
            upToDate: results.filter((r) => r.status === 'up-to-date').length,
            failed: results.filter((r) => r.status === 'failed' || r.status === 'not-found').length,
          },
          { handler: 'skills-reimport-bulk' },
        );

        try {
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          bumpSkillsCatalogGen();
          await contentFilter?.rebuildIgnorePatterns();
        } catch (e) {
          getLogger('skills-reimport-bulk').warn(
            { err: e },
            'bulk update: ignore-pattern rebuild failed after a reported success',
          );
        }
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to update skills.', {
          handler: 'skills-reimport-bulk',
          cause: e,
        });
      }
    },
    { handler: 'skills-reimport-bulk', method: 'POST' },
  );

  const handleSkillRevert = withValidation(
    SkillRevertRequestSchema,
    async (_req, res, body) => {
      try {
        if (!projectDir) {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No project root resolved.', {
            handler: 'skill-revert',
            detail: 'NO_PROJECT_ROOT',
          });
          return;
        }
        const actor = extractActorIdentity(
          body as unknown as Record<string, unknown>,
          getPrincipal,
        );
        if (actor.kind === 'invalid-summary') {
          errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Summary must be a string.', {
            handler: 'skill-revert',
          });
          return;
        }
        if (!validateSkillName(body.name, res, 'skill-revert')) return;
        if (rejectReservedBuiltinSkill(body.name, res, 'skill-revert')) return;
        if (body.scope === 'global') {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Global skills are unversioned — there is nothing to revert to.',
            { handler: 'skill-revert', detail: 'GLOBAL_SCOPE' },
          );
          return;
        }

        const lockPath = join(projectDir, ...SKILLS_LOCK_REL);
        const lock = readSkillsLockFile(lockPath);
        const entry = lock.skills[body.name];
        if (!entry?.baselineRef) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'This skill has no recorded install baseline to revert to.',
            { handler: 'skill-revert', detail: 'NO_BASELINE' },
          );
          return;
        }
        const shadow = shadowRef?.current;
        if (!shadow) {
          errorResponse(
            res,
            409,
            'urn:ok:error:shadow-not-configured',
            'No version history available to revert from.',
            { handler: 'skill-revert', detail: 'NO_SHADOW_REPO' },
          );
          return;
        }

        const result = await restoreSkillVersion({
          shadow,
          contentDir,
          contentRoot: contentRoot ?? '.',
          name: body.name,
          version: entry.baselineRef,
          skillDirRel: projectSkillDirRel(body.name),
        });
        if (!result.ok) {
          respondSkillRestoreFailure(res, result, 'skill-revert');
          return;
        }

        attributeOkArtifactWrite(
          actor,
          okArtifactKey('skill', '', body.name),
          `skill-revert: ${body.name} @ ${entry.baselineRef.slice(0, 8)}`,
        );
        await commitOkArtifactWrite('skill-revert');

        const revertRoot = resolve(contentDir, projectSkillDirRel(body.name), '..');
        const revertedLocalHash = localSkillHash(revertRoot, body.name);
        await mutateSkillsLock(lockPath, (current) =>
          upsertLockEntry(current, body.name, {
            ...(current.skills[body.name] ?? entry),
            ...(revertedLocalHash !== undefined ? { localHash: revertedLocalHash } : {}),
          }),
        );

        if (revertRoot === resolveSkillsRoot('project')) {
          await projectImportedSkillCopy({
            skillsRoot: revertRoot,
            name: body.name,
            scope: 'project',
            hasScripts: result.restoredFiles.some((f) => f.startsWith('scripts/')),
            handler: 'skill-revert',
          });
        }

        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillRevertSuccessSchema,
          {
            name: body.name,
            baselineRef: entry.baselineRef,
            restoredFiles: result.restoredFiles,
            warnings: [],
          },
          { handler: 'skill-revert' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to revert skill.', {
          handler: 'skill-revert',
          cause: e,
        });
      }
    },
    { handler: 'skill-revert', method: 'POST' },
  );
  return createApiRouteGroup(
    {
      '/api/skill/restore': handleSkillRestore,
      '/api/skill/reimport': handleSkillReimport,
      '/api/skills/reimport-bulk': handleSkillsReimportBulk,
      '/api/skill/revert': handleSkillRevert,
    },
    {
      mutating: [
        '/api/skill/restore',
        '/api/skill/reimport',
        '/api/skills/reimport-bulk',
        '/api/skill/revert',
      ],
    },
  );
}
