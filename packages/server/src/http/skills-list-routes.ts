import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EmptyRequestSchema,
  type estimateSkillCost,
  SkillsListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  parseSkillsLock,
  readRepoMarketplacePlugins,
  repoMarketplacePluginFor,
  SKILLS_LOCK_REL,
  type SkillsLock,
} from '@inkeep/open-knowledge-core/skills-catalog';
import type { ContentFilter } from '../content-filter.ts';
import {
  aliasedSourceRoots,
  isActivatedSkillRoot,
  resolveGlobalNativeSkillDir,
  scanGlobalInPlaceSkills,
  scanHostRootAliases,
  scanInPlaceSkills,
  standardSkillRoots,
} from '../in-place-skills.ts';
import { readInstalledSkills } from '../installed-skills-marker.ts';
import { openPluginBaselines } from '../plugin-skill-baseline.ts';
import {
  BUNDLE_SKILL_NAME,
  isInternalBundleSkillName,
  USER_GLOBAL_BUNDLE_IDS,
} from '../skill-bundles.ts';
import { detectProjectSkillEditors, detectUserSkillHosts } from '../skill-install.ts';
import { readSkillPlacements } from '../skill-placements.ts';
import { listSkillBundledFilePaths } from '../skill-projection.ts';
import type { SkillsCatalogCache } from '../skills-catalog-cache.ts';
import { readSkillsLockFile as readSkillsLock } from '../skills-lock-store.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsListRouteDeps {
  contentDir: string;
  projectDir: string | undefined;
  skillsHome: string;
  contentFilter: ContentFilter | undefined;
  catalogCache: SkillsCatalogCache;
  resolveSkillsRoot: (scope: 'project' | 'global') => string;
  resolveSkillsList: (
    skillsRoot: string,
    scope: 'project' | 'global',
  ) => {
    skills: Array<{
      name: string;
      description?: string;
      scope: 'project' | 'global';
      path: string;
      absolutePath: string;
      installedVersion?: string;
    }>;
    truncated: boolean;
  };
  skillOriginFor: (entry: SkillsLock['skills'][string]) => {
    source: string;
    publisher?: string;
    skill?: string;
    marketplaceUrl?: string;
    importedAt: string;
    autoUpdate?: boolean;
  };
  localSkillHash: (skillsRoot: string, name: string) => string | undefined;
  effectiveInstallMode: (
    scope: 'project' | 'global',
    name: string,
    existing: { hosts: readonly string[]; linkedHosts: readonly string[] },
  ) => 'copy' | 'link';
  pluginSelfIdentity: (
    name: string,
    identity: string,
    skillAbsDir: string,
  ) => { name: string; marketplace: string; provider: string; url?: string } | null;
  synthBuiltinLockEntry: (
    base: string,
    name: string,
    scope: 'project' | 'global',
  ) => SkillsLock['skills'][string] | null;
  synthPluginLockEntry: (
    name: string,
    identity: string,
    skillAbsDir?: string,
  ) => SkillsLock['skills'][string] | null;
  pluginUpstreamHash: (name: string, identity: string) => string | null;
  builtinSkillListEntry: (
    base: string,
    name: string,
    scope: 'project' | 'global',
  ) => {
    name: string;
    description?: string;
    scope: 'project' | 'global';
    path: string;
    absolutePath: string;
    installed: boolean;
    hosts: string[];
    managed: true;
    size?: ReturnType<typeof estimateSkillCost>;
    origin?: ReturnType<SkillsListRouteDeps['skillOriginFor']>;
  } | null;
  indexedSkillContentPath: (absolutePath: string, contentDir: string) => string | null;
  healUnservableSkillAdmission: (
    paths: readonly string[],
    filter: ContentFilter | null,
    state: { lastKey: string | null },
  ) => Promise<boolean>;
}

export function createSkillsListRoutes(deps: SkillsListRouteDeps): ApiRouteGroup {
  const {
    contentDir,
    projectDir,
    skillsHome,
    contentFilter,
    catalogCache,
    resolveSkillsRoot,
    resolveSkillsList,
    skillOriginFor,
    localSkillHash,
    effectiveInstallMode,
    pluginSelfIdentity,
    synthBuiltinLockEntry,
    synthPluginLockEntry,
    pluginUpstreamHash,
    builtinSkillListEntry,
    indexedSkillContentPath,
    healUnservableSkillAdmission,
  } = deps;
  const BUILTIN_PROJECT_SKILL_NAME = BUNDLE_SKILL_NAME.project;
  const skillAdmissionHeal: { lastKey: string | null } = { lastKey: null };

  const handleSkillsList = withValidation(
    EmptyRequestSchema,
    catchErrors(
      async (_req, res) => {
        const inPlaceFp =
          (contentFilter?.peekFreshInPlaceSkillDirsFingerprint() ?? '') +
          '\u0001' +
          (projectDir ? detectProjectSkillEditors(projectDir).join(',') : '') +
          '\u0001' +
          detectUserSkillHosts(skillsHome)
            .map((h) => h.editorId)
            .join(',') +
          '\u0001' +
          scanGlobalInPlaceSkills(skillsHome)
            .map((s) => s.dir)
            .sort()
            .join(',');
        const cached = catalogCache.readList(inPlaceFp);
        if (cached !== null) {
          successResponse(res, 200, SkillsListSuccessSchema, cached.body, {
            handler: 'skills-list',
          });
          return;
        }
        const projectSkillsRoot = resolveSkillsRoot('project');
        const project = resolveSkillsList(projectSkillsRoot, 'project');
        const globalSkills = resolveSkillsList(resolveSkillsRoot('global'), 'global');
        const projectInstallableEditors: string[] = projectDir
          ? detectProjectSkillEditors(projectDir)
          : [];
        const globalInstallableEditors: string[] = detectUserSkillHosts(skillsHome).map(
          (h) => h.editorId,
        );
        const projectHubOffered: boolean = projectDir
          ? isActivatedSkillRoot(projectDir, 'project', AGENTS_SKILLS_ROOT, skillsHome)
          : false;
        const globalHubOffered: boolean = isActivatedSkillRoot(
          skillsHome,
          'global',
          AGENTS_SKILLS_ROOT,
          skillsHome,
        );
        const projectInstalled = projectDir ? readInstalledSkills(projectDir).skills : {};
        const globalInstalled = readInstalledSkills(skillsHome).skills;
        const lock: SkillsLock | null = projectDir
          ? (parseSkillsLock(
              existsSync(join(projectDir, ...SKILLS_LOCK_REL))
                ? readFileSync(join(projectDir, ...SKILLS_LOCK_REL), 'utf-8')
                : '',
            ) ?? null)
          : null;
        const skillOrigin = skillOriginFor;
        const enrich = (
          list: typeof project,
          marker: Record<string, { hosts: string[] }>,
          withOrigin: boolean,
        ) =>
          list.skills.map((skill) => {
            const record = marker[skill.name];
            const hosts = record?.hosts ?? [];
            const entry = withOrigin ? lock?.skills[skill.name] : undefined;
            const origin = entry ? skillOrigin(entry) : undefined;
            const modified =
              entry?.localHash !== undefined &&
              localSkillHash(projectSkillsRoot, skill.name) !== entry.localHash;
            const revertable = entry?.baselineRef !== undefined;
            return {
              ...skill,
              installed: hosts.length > 0,
              hosts,
              ...(origin ? { origin } : {}),
              ...(modified ? { modified: true } : {}),
              ...(revertable ? { revertable: true } : {}),
            };
          });
        const placements = projectDir ? readSkillPlacements(projectDir) : {};
        const placementFlags = (
          baseDir: string,
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          canonicalAbs?: string,
        ): { drift: string[] } => {
          const drift: string[] = [];
          for (const p of list ?? []) {
            const abs = resolve(baseDir, p.path);
            if (canonicalAbs !== undefined && abs === resolve(canonicalAbs)) continue;
            let isLink = false;
            try {
              isLink = lstatSync(abs).isSymbolicLink();
            } catch {
              continue;
            }
            if ((isLink ? 'link' : 'copy') === p.mode) continue;
            if (isLink && canonicalAbs !== undefined) {
              try {
                if (realpathSync(abs) === realpathSync(canonicalAbs)) continue;
              } catch {}
            }
            drift.push(p.path);
          }
          return { drift };
        };
        const projectAliases = projectDir ? scanHostRootAliases(contentDir, 'project') : {};
        const projectAliasRoots = aliasedSourceRoots(projectAliases, 'project');
        const underRoots = (path: string, roots: ReadonlySet<string>): boolean =>
          [...roots].some((r) => path === r || path.startsWith(`${r}/`));
        const detectedIdentity = resolveProjectIdentity(projectDir ?? contentDir);
        const pluginBaselines = openPluginBaselines(contentDir);
        const stdRootsProject = standardSkillRoots('project');
        const stdRootsGlobal = standardSkillRoots('global');
        const dropAliased = (
          list: ReturnType<typeof readSkillPlacements>[string] | undefined,
          aliasRoots: Set<string>,
        ): ReturnType<typeof readSkillPlacements>[string] =>
          (list ?? []).filter(
            (pl) => ![...aliasRoots].some((r) => pl.path === r || pl.path.startsWith(`${r}/`)),
          );
        const projectNameSeen = new Set<string>();
        const repoPlugins = readRepoMarketplacePlugins(contentDir);
        const repoPluginIdentity = (dir: string) => {
          const p = repoMarketplacePluginFor(repoPlugins, dir);
          return p
            ? {
                name: p.name,
                marketplace: p.marketplace,
                provider: 'claude',
                ...(p.url ? { url: p.url } : {}),
              }
            : null;
        };
        const inPlace = projectDir
          ? scanInPlaceSkills(contentDir).map((s) => {
              const tracked = !projectNameSeen.has(s.name);
              projectNameSeen.add(s.name);
              const skillAbsDir = resolve(contentDir, s.dir);
              const selfPlugin = tracked
                ? (pluginSelfIdentity(s.name, detectedIdentity, skillAbsDir) ??
                  repoPluginIdentity(skillAbsDir))
                : null;
              const entry =
                tracked && selfPlugin === null
                  ? (lock?.skills[s.name] ??
                    synthBuiltinLockEntry(contentDir, s.name, 'project') ??
                    synthPluginLockEntry(s.name, detectedIdentity, skillAbsDir))
                  : undefined;
              const origin = entry ? skillOrigin(entry) : undefined;
              const modified =
                entry?.localHash !== undefined
                  ? s.contentHash !== entry.localHash
                  : (() => {
                      if (!entry || !tracked) return false;
                      const up = pluginUpstreamHash(s.name, detectedIdentity);
                      return (
                        up !== null &&
                        pluginBaselines.isModified('project', s.name, s.contentHash, up)
                      );
                    })();
              return {
                name: s.name,
                ...(s.description ? { description: s.description } : {}),
                scope: 'project' as const,
                path: `${s.dir}/SKILL.md`,
                absolutePath: resolve(contentDir, s.dir, 'SKILL.md'),
                installed: true,
                hosts: [...s.hosts],
                size: s.size,
                installableEditors: projectInstallableEditors,
                hubOffered: projectHubOffered,
                ...(s.pack !== undefined ? { pack: s.pack } : {}),
                ...(s.linkedHosts.length > 0 ? { symlinkedHosts: [...s.linkedHosts] } : {}),
                ...(Object.keys(projectAliases).length > 0 ? { hostAliases: projectAliases } : {}),
                ...(s.conflictHosts.length > 0 ? { conflictHosts: [...s.conflictHosts] } : {}),
                ...(selfPlugin !== null ? { plugin: selfPlugin } : {}),
                ...(() => {
                  const custom = dropAliased(
                    tracked ? placements[s.name] : undefined,
                    projectAliasRoots,
                  ).filter((cp) => !underRoots(cp.path, stdRootsProject));
                  return custom.length
                    ? { customPlacements: custom.map((cp) => ({ path: cp.path, mode: cp.mode })) }
                    : {};
                })(),
                ...(() => {
                  const f = placementFlags(
                    projectDir,
                    dropAliased(tracked ? placements[s.name] : undefined, projectAliasRoots),
                    resolve(contentDir, s.dir),
                  );
                  return f.drift.length > 0 ? { driftPaths: f.drift } : {};
                })(),
                ...(effectiveInstallMode('project', s.name, s) === 'link'
                  ? { linkMode: true }
                  : {}),
                ...(origin ? { origin } : {}),
                ...(modified ? { modified: true } : {}),
                ...(entry?.baselineRef !== undefined ? { revertable: true } : {}),
                ...(isInternalBundleSkillName(s.name) ? { managed: true as const } : {}),
              };
            })
          : [];
        const globalPlacements = readSkillPlacements(skillsHome);
        const globalLock = readSkillsLock(join(skillsHome, ...SKILLS_LOCK_REL));
        const globalAliases = scanHostRootAliases(skillsHome, 'global');
        const globalAliasRoots = aliasedSourceRoots(globalAliases, 'global');
        const globalInPlaceNames = new Set(scanGlobalInPlaceSkills(skillsHome).map((s) => s.name));
        globalSkills.skills = globalSkills.skills.filter((s) => !globalInPlaceNames.has(s.name));
        const globalNameSeen = new Set<string>();
        const globalInPlace = scanGlobalInPlaceSkills(skillsHome).map((s) => {
          const tracked = !globalNameSeen.has(s.name);
          globalNameSeen.add(s.name);
          const placementsForRow = tracked ? globalPlacements[s.name] : undefined;
          const defaultDir = resolveGlobalNativeSkillDir(skillsHome, s.name);
          const hostQualifier =
            defaultDir !== null && resolve(skillsHome, s.dir) !== resolve(defaultDir)
              ? s.hosts[0]
              : undefined;
          return {
            name: s.name,
            ...(s.description ? { description: s.description } : {}),
            scope: 'global' as const,
            path: `${s.dir}/SKILL.md`,
            absolutePath: resolve(skillsHome, s.dir, 'SKILL.md'),
            installed: true,
            hosts: [...s.hosts],
            ...(hostQualifier !== undefined ? { hostQualifier } : {}),
            size: s.size,
            installableEditors: globalInstallableEditors,
            hubOffered: globalHubOffered,
            ...(s.pack !== undefined ? { pack: s.pack } : {}),
            ...(s.linkedHosts.length > 0 ? { symlinkedHosts: [...s.linkedHosts] } : {}),
            ...(Object.keys(globalAliases).length > 0 ? { hostAliases: globalAliases } : {}),
            ...(s.conflictHosts.length > 0 ? { conflictHosts: [...s.conflictHosts] } : {}),
            ...(() => {
              const f = placementFlags(
                skillsHome,
                dropAliased(placementsForRow, globalAliasRoots),
                resolve(skillsHome, s.dir),
              );
              return f.drift.length > 0 ? { driftPaths: f.drift } : {};
            })(),
            ...(() => {
              const custom = dropAliased(placementsForRow, globalAliasRoots).filter(
                (cp) => !underRoots(cp.path, stdRootsGlobal),
              );
              return custom.length
                ? { customPlacements: custom.map((cp) => ({ path: cp.path, mode: cp.mode })) }
                : {};
            })(),
            ...(effectiveInstallMode('global', s.name, s) === 'link' ? { linkMode: true } : {}),
            ...(isInternalBundleSkillName(s.name) ? { managed: true as const } : {}),
            ...(() => {
              if (!tracked) return {};
              const globalAbsDir = resolve(skillsHome, s.dir);
              const selfPluginGlobal = pluginSelfIdentity(s.name, detectedIdentity, globalAbsDir);
              if (selfPluginGlobal !== null) return { plugin: selfPluginGlobal };
              const entry =
                globalLock.skills[s.name] ??
                synthBuiltinLockEntry(skillsHome, s.name, 'global') ??
                synthPluginLockEntry(s.name, detectedIdentity, globalAbsDir);
              if (!entry) return {};
              const globallyModified =
                entry.localHash !== undefined
                  ? s.contentHash !== entry.localHash
                  : (() => {
                      const up = pluginUpstreamHash(s.name, detectedIdentity);
                      return (
                        up !== null &&
                        pluginBaselines.isModified('global', s.name, s.contentHash, up)
                      );
                    })();
              return {
                origin: skillOrigin(entry),
                ...(globallyModified ? { modified: true } : {}),
              };
            })(),
          };
        });
        const inPlaceNamesEarly = new Set(inPlace.map((e) => e.name));
        const projectBuiltin =
          projectDir &&
          !project.skills.some((s) => s.name === BUILTIN_PROJECT_SKILL_NAME) &&
          !inPlaceNamesEarly.has(BUILTIN_PROJECT_SKILL_NAME)
            ? builtinSkillListEntry(projectDir, BUILTIN_PROJECT_SKILL_NAME, 'project')
            : null;
        const globalInPlaceNamesEarly = new Set(globalInPlace.map((e) => e.name));
        const globalBuiltins = USER_GLOBAL_BUNDLE_IDS.map((id) => BUNDLE_SKILL_NAME[id])
          .filter(
            (name) =>
              !globalSkills.skills.some((s) => s.name === name) &&
              !globalInPlaceNamesEarly.has(name),
          )
          .map((name) => builtinSkillListEntry(skillsHome, name, 'global'))
          .filter((e): e is NonNullable<typeof e> => e !== null);
        const inPlaceNames = new Set(inPlace.map((e) => e.name));
        const listed = [
          ...enrich(project, projectInstalled, true).filter((e) => !inPlaceNames.has(e.name)),
          ...inPlace,
          ...enrich(globalSkills, globalInstalled, false),
          ...globalInPlace,
          ...(projectBuiltin ? [projectBuiltin] : []),
          ...globalBuiltins,
        ];
        pluginBaselines.flush();
        const enriched = {
          skills: listed.map((entry) => {
            const canonicalPath =
              entry.scope === 'project' && entry.absolutePath
                ? indexedSkillContentPath(entry.absolutePath, contentDir)
                : null;
            const filePaths = entry.absolutePath
              ? listSkillBundledFilePaths(dirname(entry.absolutePath))
              : [];
            const withFiles = filePaths.length > 0 ? { ...entry, filePaths } : entry;
            const withCanonical =
              canonicalPath === null || canonicalPath === entry.path
                ? withFiles
                : { ...withFiles, canonicalPath };
            const openedPath = canonicalPath ?? entry.path;
            return entry.scope === 'project' && contentFilter?.isPathIgnored(openedPath) === true
              ? { ...withCanonical, ignored: true }
              : withCanonical;
          }),
          truncated: project.truncated || globalSkills.truncated,
        };
        const healed = await healUnservableSkillAdmission(
          inPlace.map((e) => e.path),
          contentFilter ?? null,
          skillAdmissionHeal,
        );
        const responseBody = !healed
          ? enriched
          : {
              ...enriched,
              skills: enriched.skills.map((entry) => {
                if (entry.scope !== 'project') return entry;
                const opened = (entry as { canonicalPath?: string }).canonicalPath ?? entry.path;
                const nowIgnored = contentFilter?.isPathIgnored(opened) === true;
                const wasIgnored = (entry as { ignored?: boolean }).ignored === true;
                if (nowIgnored === wasIgnored) return entry;
                if (nowIgnored) return { ...entry, ignored: true };
                const { ignored: _drop, ...rest } = entry as { ignored?: boolean } & typeof entry;
                return rest;
              }),
            };
        catalogCache.writeList(inPlaceFp, responseBody);
        successResponse(res, 200, SkillsListSuccessSchema, responseBody, {
          handler: 'skills-list',
        });
      },
      { handler: 'skills-list', title: 'Failed to list skills.' },
    ),
    { handler: 'skills-list', method: 'GET', skipBodyParse: true },
  );

  return createApiRouteGroup({ '/api/skills': handleSkillsList });
}
