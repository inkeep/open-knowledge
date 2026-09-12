import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  type EditorId,
  isSkillInstallTarget,
  PROJECT_SKILL_EDITOR_IDS,
  SkillInstallRequestSchema,
  SkillInstallSuccessSchema,
  type SkillInstallWarningCode,
  skillLiveDocName,
  USER_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import type { SkillHostId } from '@inkeep/open-knowledge-core/skills-catalog';
import { parseSkillsLock, SKILLS_LOCK_REL } from '@inkeep/open-knowledge-core/skills-catalog';
import type { ContentFilter } from '../content-filter.ts';
import type { StoreFailure } from '../document-durability-state.ts';
import { scanGlobalInPlaceSkills, scanInPlaceSkills } from '../in-place-skills.ts';
import {
  readInstalledSkills,
  recordSkillInstall,
  removeSkillInstall,
} from '../installed-skills-marker.ts';
import type { PinoLogger } from '../logger.ts';
import type { SkillInstallOpsDeps, SkillInstallOpsService } from '../services/skill-install-ops.ts';
import type { SkillPlacementOpsService } from '../services/skill-placement-ops.ts';
import { isInternalBundleSkillName } from '../skill-bundles.ts';
import { detectUserSkillHosts } from '../skill-install.ts';
import {
  projectSkill,
  resolvedHosts,
  resolveSkillTargets,
  reverseProjectSkill,
  skillProjectionRoots,
  validateSkillForInstall,
} from '../skill-projection.ts';
import { type ApiRouteGroup, createApiRouteGroup } from './api-pipeline.ts';
import { errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

export interface SkillsInstallRouteDeps {
  resolveSkillsRoot: (scope: 'project' | 'global') => string;
  validateSkillName: (name: string, res: ServerResponse, handler: string) => boolean;
  projectDir: string | undefined;
  skillInstallBase: (scope: 'project' | 'global') => string | undefined;
  contentDir: string;
  skillsHome: string;
  shippedBundleSkillMd: (name: string, scope?: 'project' | 'global') => string | null;
  respondStaleExternalWrite: (res: ServerResponse, handler: string, docName: string) => void;
  flushDiskAndDetectOutcome: (
    docName: string,
  ) => Promise<
    | { kind: 'failure'; failure: StoreFailure }
    | { kind: 'divergence' }
    | { kind: 'stale-external-write' }
    | null
  >;
  skillInstallOps: SkillInstallOpsService;
  skillPlacementOps: SkillPlacementOpsService;
  signalChannel: ((channel: 'files' | 'lint-config' | 'comments') => void) | undefined;
  bumpSkillsCatalogGen: () => void;
  contentFilter: ContentFilter | undefined;
  scheduleDeferredIgnoreRebuild: () => void;
  effectiveInstallMode: SkillInstallOpsDeps['effectiveInstallMode'];
  log: PinoLogger;
}

export function createSkillsInstallRoutes(deps: SkillsInstallRouteDeps): ApiRouteGroup {
  const {
    resolveSkillsRoot,
    validateSkillName,
    projectDir,
    skillInstallBase,
    contentDir,
    skillsHome,
    shippedBundleSkillMd,
    flushDiskAndDetectOutcome,
    respondStaleExternalWrite,
    skillInstallOps,
    skillPlacementOps,
    signalChannel,
    bumpSkillsCatalogGen,
    contentFilter,
    scheduleDeferredIgnoreRebuild,
    effectiveInstallMode,
    log,
  } = deps;
  const handleSkillInstall = withValidation(
    SkillInstallRequestSchema,
    async (_req, res, body) => {
      try {
        const skillsRoot = resolveSkillsRoot(body.scope);
        if (!validateSkillName(body.name, res, 'skill-install')) return;

        if (body.scope === 'project' && !projectDir) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            'Cannot install — no project root is resolved for this server. Skills project into editor host dirs at the project root.',
            { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
          );
          return;
        }
        const base = skillInstallBase(body.scope) as string;

        const storeSkillDir = resolve(skillsRoot, body.name);
        const inPlaceScanBase = body.scope === 'project' ? contentDir : skillsHome;
        const inPlaceEntry = (
          body.scope === 'project'
            ? scanInPlaceSkills(contentDir)
            : scanGlobalInPlaceSkills(skillsHome)
        ).find((s) => s.name === body.name);
        const bundleSource = isInternalBundleSkillName(body.name)
          ? shippedBundleSkillMd(body.name, body.scope)
          : null;
        const skillDir = inPlaceEntry
          ? resolve(inPlaceScanBase, inPlaceEntry.dir)
          : existsSync(storeSkillDir) || bundleSource === null
            ? storeSkillDir
            : dirname(bundleSource);
        if (!existsSync(skillDir)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Skill not found.', {
            handler: 'skill-install',
            detail: `Skill "${body.name}" not found in ${body.scope} scope — create it with write({ skill }) first.`,
          });
          return;
        }

        const liveSkillDoc =
          body.scope === 'project'
            ? `${relative(inPlaceScanBase, skillDir).split(sep).join('/')}/SKILL`
            : skillLiveDocName(body.scope, body.name);
        const liveSkillFlush = await flushDiskAndDetectOutcome(liveSkillDoc);
        if (liveSkillFlush?.kind === 'stale-external-write') {
          respondStaleExternalWrite(res, 'skill-install', liveSkillDoc);
          return;
        }

        const validity = validateSkillForInstall(skillDir, body.name, {
          allowReservedName: isInternalBundleSkillName(body.name),
        });
        if (!validity.ok) {
          errorResponse(
            res,
            400,
            'urn:ok:error:invalid-request',
            `Skill "${body.name}" cannot be installed: ${validity.errors.join(' ')}`,
            { handler: 'skill-install', detail: 'INVALID_SKILL_SOURCE' },
          );
          return;
        }

        if (body.fork !== undefined) {
          if (!inPlaceEntry) {
            errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Skill is not in-place.', {
              handler: 'skill-install',
              detail: 'FORK_STORE_BACKED',
            });
            return;
          }
          const forkResolved = skillInstallOps.resolveFork({
            scope: body.scope,
            name: body.name,
            fork: body.fork,
            inPlaceEntry,
          });
          if (!forkResolved.ok) {
            switch (forkResolved.kind) {
              case 'unknown-editor':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Unknown editor.', {
                  handler: 'skill-install',
                  detail: forkResolved.editor,
                });
                return;
              case 'fork-absent':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'No fork at that editor.', {
                  handler: 'skill-install',
                  detail: 'FORK_ABSENT',
                });
                return;
              case 'not-a-fork':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'That copy matches the source — nothing to resolve.',
                  { handler: 'skill-install', detail: 'NOT_A_FORK' },
                );
                return;
              case 'invalid-new-name':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid new name.', {
                  handler: 'skill-install',
                  detail: forkResolved.toName,
                });
                return;
              case 'name-taken':
                errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Name already taken.', {
                  handler: 'skill-install',
                  detail: forkResolved.toName,
                });
                return;
              default: {
                const _exhaustive: never = forkResolved;
                throw new Error(
                  `Unhandled fork outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry.hosts.filter(isSkillInstallTarget),
              scripts: false,
              warnings: forkResolved.warnings,
              warningCodes: forkResolved.warnings.length > 0 ? ['skill-fork-name-unpatched'] : [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        const setSourceReq = body.setSource ?? body.source;
        const linkModeReq =
          body.linkMode ?? (body.mode !== undefined ? body.mode === 'link' : undefined);
        let targetsReq = body.targets;
        const rootAdds: string[] = [];
        const rootRemoves: string[] = [];
        if (body.add !== undefined || body.remove !== undefined) {
          if (!inPlaceEntry) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'This skill still lives in the legacy .ok/skills store — promote a real location first (`source`) before using add/remove.',
              { handler: 'skill-install', detail: 'STORE_BACKED_ADDITIVE' },
            );
            return;
          }
          const addRemove = await skillInstallOps.applyAddRemove({
            scope: body.scope,
            name: body.name,
            inPlaceEntry,
            ...(body.add !== undefined ? { add: body.add } : {}),
            ...(body.remove !== undefined ? { remove: body.remove } : {}),
          });
          if (!addRemove.ok) {
            if (addRemove.kind === 'remove-source') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                `"${addRemove.sourceId}" is the skill's SOURCE — its folder is the skill itself, so removing it would delete the skill. Move the source first (\`source\`) or use \`delete\`.`,
                { handler: 'skill-install', detail: 'REMOVE_SOURCE' },
              );
            } else {
              errorResponse(
                res,
                409,
                'urn:ok:error:invalid-request',
                `Could not stop ${addRemove.subRoot} following its pool (${addRemove.reason}).`,
                { handler: 'skill-install', detail: addRemove.reason },
              );
            }
            return;
          }
          targetsReq = addRemove.targets.filter(isSkillInstallTarget);
          rootAdds.push(...addRemove.rootAdds);
          rootRemoves.push(...addRemove.rootRemoves);
        }

        if (setSourceReq && !inPlaceEntry) {
          const promoted = await skillInstallOps.promoteStoreBackedSource({
            scope: body.scope,
            name: body.name,
            base,
            skillDir,
            newSource: setSourceReq as SkillHostId,
          });
          if (!promoted.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:doc-already-exists',
              'Cannot move the source there — a different skill occupies the target.',
              {
                handler: 'skill-install',
                detail: promoted.kind === 'source-occupied' ? promoted.reason : promoted.target,
              },
            );
            return;
          }
          signalChannel?.('files');
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: promoted.hosts,
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
              sourceMovedTo: promoted.sourceMovedTo,
            },
            { handler: 'skill-install' },
          );
          return;
        }

        if (body.place) {
          const placeBase = body.scope === 'project' ? projectDir : skillsHome;
          if (!placeBase) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot place — no project root is resolved for this server.',
              { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          const placed = await skillPlacementOps.place({
            placeBase,
            name: body.name,
            rawDir: body.place.dir,
            skillDir,
            mode: body.place.mode,
          });
          if (!placed.ok) {
            if (placed.kind === 'invalid-path') {
              errorResponse(
                res,
                400,
                'urn:ok:error:invalid-request',
                'Placement path must be a project-relative directory outside .ok/.',
                { handler: 'skill-install', detail: 'PLACE_PATH_INVALID' },
              );
            } else {
              errorResponse(
                res,
                409,
                'urn:ok:error:doc-already-exists',
                'Something already exists at that path — placement never overwrites.',
                { handler: 'skill-install', detail: 'PLACE_DEST_EXISTS' },
              );
            }
            return;
          }
          if (!('alreadyAtSource' in placed)) {
            signalChannel?.('files');
          }
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry ? [...inPlaceEntry.hosts] : [],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
              placedAt: placed.placedAt,
            },
            { handler: 'skill-install' },
          );
          return;
        }

        if (body.unplace) {
          const placeBase = body.scope === 'project' ? projectDir : skillsHome;
          if (!placeBase) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'Cannot remove a placement — no project root is resolved for this server.',
              { handler: 'skill-install', detail: 'NO_PROJECT_ROOT' },
            );
            return;
          }
          const unplaced = await skillPlacementOps.unplace({
            placeBase,
            name: body.name,
            rawPath: body.unplace.path,
            skillDir,
          });
          if (!unplaced.ok) {
            switch (unplaced.kind) {
              case 'not-recorded':
                errorResponse(
                  res,
                  404,
                  'urn:ok:error:not-found',
                  'No recorded placement at that path.',
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              case 'unsafe-path':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'Recorded placement path is no longer safe.',
                  { handler: 'skill-install', detail: 'PLACE_PATH_INVALID' },
                );
                return;
              case 'forked':
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'That copy has been edited and no longer matches the skill — remove it manually if you mean it.',
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              case 'canonical-dir':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  "That is the skill's own folder (the source) — it can't be removed here.",
                  { handler: 'skill-install', detail: unplaced.path },
                );
                return;
              default: {
                const _exhaustive: never = unplaced;
                throw new Error(
                  `Unhandled unplace outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          bumpSkillsCatalogGen();
          contentFilter?.refreshInPlaceSkillDirs();
          scheduleDeferredIgnoreRebuild();
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: inPlaceEntry ? [...inPlaceEntry.hosts] : [],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        if (body.convert) {
          if (!inPlaceEntry) {
            errorResponse(
              res,
              400,
              'urn:ok:error:invalid-request',
              'This skill still lives in the legacy .ok/skills store — promote a real location first (`source`) before converting one.',
              { handler: 'skill-install', detail: 'STORE_BACKED_CONVERT' },
            );
            return;
          }
          const { target, mode } = body.convert;
          const prefBase = body.scope === 'project' ? projectDir : skillsHome;
          const converted = await skillPlacementOps.convert({
            ledgerBase: prefBase ?? base,
            scope: body.scope,
            name: body.name,
            target,
            mode,
            skillDir,
            canonicalHash: inPlaceEntry.contentHash,
          });
          if (!converted.ok) {
            switch (converted.kind) {
              case 'invalid-location':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'That location has no skills folder to convert.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'canonical-dir':
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  "That is the skill's own folder (the source) — move the source instead of converting it.",
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'forked':
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'That copy has been edited and no longer matches the skill — resolve the fork before converting it.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              case 'not-installed':
                errorResponse(
                  res,
                  404,
                  'urn:ok:error:not-found',
                  'The skill is not installed there.',
                  { handler: 'skill-install', detail: target },
                );
                return;
              default: {
                const _exhaustive: never = converted;
                throw new Error(
                  `Unhandled convert outcome: ${String((_exhaustive as { kind?: unknown }).kind)}`,
                );
              }
            }
          }
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: [...inPlaceEntry.hosts],
              scripts: validity.hasScripts,
              warnings: [],
              warningCodes: [],
            },
            { handler: 'skill-install' },
          );
          return;
        }

        const targets: EditorId[] =
          body.scope === 'global'
            ? targetsReq !== undefined
              ? USER_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : detectUserSkillHosts(skillsHome).map((host) => host.editorId)
            : targetsReq !== undefined
              ? PROJECT_SKILL_EDITOR_IDS.filter((id) => targetsReq?.some((t) => t === id))
              : resolveSkillTargets(base);
        const warnings: string[] = [];
        const warningCodes: SkillInstallWarningCode[] = [];
        if (targets.length === 0 && targetsReq === undefined) {
          warnings.push(
            body.scope === 'global'
              ? 'No editor skill folders are configured to install into.'
              : 'No project-configured editors detected — nothing was projected. Set up an editor for this project (add .mcp.json / .cursor/mcp.json / .codex/config.toml) or pass explicit `targets`.',
          );
          warningCodes.push('no-targets');
        }
        if (validity.hasScripts) {
          warnings.push(
            'This skill includes executable `scripts/`. After you install it, the AI agent in your editor (Claude, Cursor, Codex) can run them — Open Knowledge itself never runs anything. Review the scripts before sharing.',
          );
          warningCodes.push('scripts-present');
        }
        if (validity.warnings.length > 0) {
          warnings.push(validity.warnings[0]);
          warningCodes.push('no-description');
        }

        if (inPlaceEntry) {
          const canonicalRootRel = inPlaceEntry.dir.split('/').slice(0, -1).join('/');
          const hubTargeted =
            targetsReq !== undefined
              ? targetsReq.includes('agents')
              : body.scope === 'global' && existsSync(join(skillsHome, '.agents'));
          const inPlaceTargets: SkillHostId[] = hubTargeted ? [...targets, 'agents'] : [...targets];
          const prefBase = body.scope === 'project' ? projectDir : skillsHome;
          const installMode: 'copy' | 'link' =
            linkModeReq !== undefined
              ? linkModeReq
                ? 'link'
                : 'copy'
              : effectiveInstallMode(body.scope, body.name, inPlaceEntry);
          if (setSourceReq) {
            const promoted = await skillInstallOps.promoteInPlaceSource({
              scope: body.scope,
              name: body.name,
              base,
              ...(prefBase ? { prefBase } : {}),
              skillDir,
              inPlaceEntry,
              newSource: setSourceReq,
            });
            if (!promoted.ok) {
              if (promoted.kind === 'invalid-target') {
                errorResponse(
                  res,
                  400,
                  'urn:ok:error:invalid-request',
                  'Source target must be an editor id, "agents", or a project-relative skills root.',
                  { handler: 'skill-install', detail: promoted.target },
                );
              } else {
                errorResponse(
                  res,
                  409,
                  'urn:ok:error:doc-already-exists',
                  'Cannot move the source there — a different skill occupies the target.',
                  { handler: 'skill-install', detail: promoted.reason },
                );
              }
              return;
            }
            signalChannel?.('files');
            successResponse(
              res,
              200,
              SkillInstallSuccessSchema,
              {
                name: body.name,
                hosts: promoted.hosts,
                scripts: validity.hasScripts,
                warnings: [],
                warningCodes: [],
                ...(promoted.sourceMovedTo !== undefined
                  ? { sourceMovedTo: promoted.sourceMovedTo }
                  : {}),
              },
              { handler: 'skill-install' },
            );
            return;
          }

          const fanOut = await skillInstallOps.fanOutInPlace({
            scope: body.scope,
            name: body.name,
            base,
            ...(prefBase ? { prefBase } : {}),
            skillDir,
            inPlaceEntry,
            canonicalRootRel,
            inPlaceTargets,
            setExact: targetsReq !== undefined,
            installMode,
            ...(linkModeReq !== undefined ? { linkModeReq } : {}),
            rootAdds,
            rootRemoves,
          });
          if (!fanOut.ok) {
            errorResponse(
              res,
              409,
              'urn:ok:error:doc-already-exists',
              'Cannot move the source there — a different skill occupies the target.',
              { handler: 'skill-install', detail: fanOut.reason },
            );
            return;
          }
          warnings.push(...fanOut.warnings);
          warningCodes.push(...fanOut.warningCodes);
          signalChannel?.('files');
          successResponse(
            res,
            200,
            SkillInstallSuccessSchema,
            {
              name: body.name,
              hosts: fanOut.hosts,
              scripts: validity.hasScripts,
              warnings,
              warningCodes,
              ...(fanOut.sourceMovedTo !== undefined
                ? { sourceMovedTo: fanOut.sourceMovedTo }
                : {}),
            },
            { handler: 'skill-install' },
          );
          return;
        }

        const priorHosts = resolvedHosts(
          readInstalledSkills(base).skills[body.name]?.hosts ?? [],
          body.scope,
        );
        const dropped = priorHosts.filter((h) => !targets.includes(h));
        if (dropped.length > 0)
          reverseProjectSkill(body.name, base, dropped, skillProjectionRoots(body.scope));
        const lockPathForInstall = join(base, ...SKILLS_LOCK_REL);
        const lockRawForInstall = existsSync(lockPathForInstall)
          ? readFileSync(lockPathForInstall, 'utf-8')
          : null;
        const lockForInstall =
          lockRawForInstall !== null ? parseSkillsLock(lockRawForInstall) : null;
        if (lockRawForInstall !== null && lockForInstall === null) {
          log.warn(
            { skill: body.name },
            'skills-lock.json failed to parse — projecting as symlink (import origin unknown)',
          );
        }
        const isAcquired = lockForInstall?.skills[body.name] !== undefined;
        const projectionMode: 'symlink' | 'copy' =
          linkModeReq !== undefined
            ? linkModeReq
              ? 'symlink'
              : 'copy'
            : isAcquired
              ? 'copy'
              : 'symlink';
        const hosts = projectSkill(
          skillDir,
          body.name,
          base,
          targets,
          projectionMode,
          skillProjectionRoots(body.scope),
        );
        if (hosts.length === 0) {
          await removeSkillInstall(base, body.name);
        } else {
          await recordSkillInstall(base, body.name, {
            hosts,
            scope: body.scope,
            scripts: validity.hasScripts,
            installedAt: new Date().toISOString(),
            projection: projectionMode,
          });
        }
        signalChannel?.('files');
        successResponse(
          res,
          200,
          SkillInstallSuccessSchema,
          { name: body.name, hosts, scripts: validity.hasScripts, warnings, warningCodes },
          { handler: 'skill-install' },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to install skill.', {
          handler: 'skill-install',
          cause: e,
        });
      }
    },
    // STOP: Unlike /api/install-skill, this route serves local-api-dispatch.ts callers without a socket; checkLocalOpSecurity requires one.
    { handler: 'skill-install', method: 'POST' },
  );

  return createApiRouteGroup(
    { '/api/skill/install': handleSkillInstall },
    { mutating: ['/api/skill/install'] },
  );
}
