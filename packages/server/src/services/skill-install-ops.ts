import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  applyPatchToFm,
  detectFmRegion,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  isSkillInstallTarget,
  SKILL_NAME_REGEX,
  type SkillInstallWarningCode,
} from '@inkeep/open-knowledge-core';
import { parseSkillDir, type SkillHostId } from '@inkeep/open-knowledge-core/skills-catalog';
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedSymlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import {
  scanGlobalInPlaceSkills,
  scanHostRootAliases,
  scanInPlaceSkills,
} from '../in-place-skills.ts';
import { removeSkillInstall } from '../installed-skills-marker.ts';
import { getLogger } from '../logger.ts';
import { unlinkEditorSkillFolder } from '../skill-folder-links.ts';
import {
  isRefusedOkPlacementRoot,
  readSkillPlacements,
  recordFolderExpectation,
  recordSkillPlacement,
  recordSkillSourceHost,
  removeSkillPlacement,
  resolveSkillPlacementPath,
} from '../skill-placements.ts';
import {
  classifyInPlaceDest,
  hostSlotPaths,
  projectInPlaceSkill,
  relocateInPlaceCanonical,
  removeInPlaceSkillCopies,
  repointSiblingLinks,
  skillProjectionRoots,
} from '../skill-projection.ts';

const log = getLogger('skill-install');

interface ForkCanonical {
  dir: string;
  contentHash: string;
  hosts: readonly string[];
  linkedHosts?: readonly string[];
}

type ResolveForkOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; kind: 'unknown-editor'; editor: string }
  | { ok: false; kind: 'fork-absent' }
  | { ok: false; kind: 'not-a-fork' }
  | { ok: false; kind: 'invalid-new-name'; toName: string }
  | { ok: false; kind: 'name-taken'; toName: string };

type ApplyAddRemoveOutcome =
  | { ok: true; targets: string[]; rootAdds: string[]; rootRemoves: string[] }
  | { ok: false; kind: 'remove-source'; sourceId: string }
  | { ok: false; kind: 'unfollow-failed'; subRoot: string; reason: string };

type PromoteSourceOutcome =
  | { ok: true; hosts: string[]; sourceMovedTo?: string }
  | { ok: false; kind: 'invalid-target'; target: string }
  | { ok: false; kind: 'source-occupied'; reason: string };

type FanOutInPlaceOutcome =
  | {
      ok: true;
      hosts: string[];
      warnings: string[];
      warningCodes: SkillInstallWarningCode[];
      sourceMovedTo?: string;
    }
  | { ok: false; kind: 'source-occupied'; reason: string };

export interface SkillInstallOpsDeps {
  contentDir: string;
  skillsHome: string;
  effectiveInstallMode: (
    scope: 'project' | 'global',
    name: string,
    entry: { hosts: readonly string[]; linkedHosts: readonly string[] },
  ) => 'copy' | 'link';
}

export interface SkillInstallOpsService {
  resolveFork(input: {
    scope: 'project' | 'global';
    name: string;
    fork: { editor: string; action: 'align' | 'make-source' | 'rename'; toName?: string };
    inPlaceEntry: ForkCanonical;
  }): ResolveForkOutcome;
  applyAddRemove(input: {
    scope: 'project' | 'global';
    name: string;
    inPlaceEntry: ForkCanonical;
    add?: readonly string[];
    remove?: readonly string[];
  }): Promise<ApplyAddRemoveOutcome>;
  promoteStoreBackedSource(input: {
    scope: 'project' | 'global';
    name: string;
    base: string;
    skillDir: string;
    newSource: SkillHostId;
  }): Promise<PromoteSourceOutcome>;
  promoteInPlaceSource(input: {
    scope: 'project' | 'global';
    name: string;
    base: string;
    prefBase?: string;
    skillDir: string;
    inPlaceEntry: ForkCanonical;
    newSource: string;
  }): Promise<PromoteSourceOutcome>;
  fanOutInPlace(input: {
    scope: 'project' | 'global';
    name: string;
    base: string;
    prefBase?: string;
    skillDir: string;
    inPlaceEntry: ForkCanonical;
    canonicalRootRel: string;
    inPlaceTargets: SkillHostId[];
    setExact: boolean;
    installMode: 'copy' | 'link';
    linkModeReq?: boolean;
    rootAdds: string[];
    rootRemoves: string[];
  }): Promise<FanOutInPlaceOutcome>;
}

export function createSkillInstallOpsService(deps: SkillInstallOpsDeps): SkillInstallOpsService {
  const scanScope = (scope: 'project' | 'global') =>
    scope === 'project'
      ? scanInPlaceSkills(deps.contentDir)
      : scanGlobalInPlaceSkills(deps.skillsHome);

  return {
    resolveFork(input) {
      const { scope, name, fork, inPlaceEntry } = input;
      const inPlaceScanBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const forkWarnings: string[] = [];
      const rootMap = scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT;
      const forkRootRel =
        fork.editor === 'agents' ? AGENTS_SKILLS_ROOT : (rootMap[fork.editor as EditorId] ?? null);
      if (forkRootRel === null) {
        return { ok: false, kind: 'unknown-editor', editor: fork.editor };
      }
      const forkDir = resolve(inPlaceScanBase, forkRootRel, name);
      const canonicalAbs = resolve(inPlaceScanBase, inPlaceEntry.dir);
      const forkParsed = parseSkillDir(forkDir);
      if (forkParsed === null || forkDir === canonicalAbs) {
        return { ok: false, kind: 'fork-absent' };
      }
      if (forkParsed.contentHash === inPlaceEntry.contentHash) {
        return { ok: false, kind: 'not-a-fork' };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stash = (dirAbs: string, label: string): void => {
        try {
          const dest = resolve(
            deps.skillsHome,
            '.ok',
            'edit-backups',
            'forks',
            `${name}-${label}-${stamp}`,
          );
          tracedMkdirSync(resolve(dest, '..'), { recursive: true });
          tracedCpSync(dirAbs, dest, { recursive: true });
        } catch (e) {
          log.warn({ name, err: e }, '[skill-fork] stash failed');
        }
      };
      if (fork.action === 'align') {
        stash(forkDir, fork.editor);
        tracedRmSync(forkDir, { recursive: true, force: true });
        projectInPlaceSkill({
          canonicalAbs,
          canonicalHash: inPlaceEntry.contentHash,
          canonicalRootRel: dirname(inPlaceEntry.dir),
          name,
          cwd: inPlaceScanBase,
          targets: [fork.editor as SkillHostId].filter(isSkillInstallTarget),
          roots: skillProjectionRoots(scope),
        });
      } else if (fork.action === 'make-source') {
        const oldHosts = inPlaceEntry.hosts.filter(isSkillInstallTarget);
        stash(canonicalAbs, 'source');
        removeInPlaceSkillCopies({
          canonicalAbs,
          canonicalHash: inPlaceEntry.contentHash,
          name,
          cwd: inPlaceScanBase,
          targets: oldHosts,
          roots: skillProjectionRoots(scope),
        });
        tracedRmSync(canonicalAbs, { recursive: true, force: true });
        const rescanned = scanScope(scope).find((sk) => sk.name === name);
        if (rescanned) {
          projectInPlaceSkill({
            canonicalAbs: resolve(inPlaceScanBase, rescanned.dir),
            canonicalHash: rescanned.contentHash,
            canonicalRootRel: dirname(rescanned.dir),
            name,
            cwd: inPlaceScanBase,
            targets: oldHosts,
            roots: skillProjectionRoots(scope),
          });
        }
      } else {
        const toName = fork.toName as string;
        if (!SKILL_NAME_REGEX.test(toName)) {
          return { ok: false, kind: 'invalid-new-name', toName };
        }
        if (scanScope(scope).some((sk) => sk.name === toName)) {
          return { ok: false, kind: 'name-taken', toName };
        }
        const dest = resolve(inPlaceScanBase, forkRootRel, toName);
        tracedRenameSync(forkDir, dest);
        const skillMdPath = resolve(dest, 'SKILL.md');
        try {
          const raw = readFileSync(skillMdPath, 'utf-8');
          const { fenced, body: skillBody } = detectFmRegion(raw);
          // presence-exempt: no CRDT write, no agent identity
          const renamed = applyPatchToFm(fenced, { name: toName });
          if (renamed.ok) {
            tracedWriteFileSync(skillMdPath, `${renamed.nextFenced}${skillBody}`);
          } else {
            log.warn(
              { name: toName, reason: renamed.error.kind },
              '[skill-fork] frontmatter rename failed',
            );
            forkWarnings.push(
              `Renamed the folder to "${toName}", but its SKILL.md still declares the old name — edit the frontmatter to match.`,
            );
          }
        } catch (e) {
          log.warn({ name: toName, err: e }, '[skill-fork] frontmatter rename failed');
          forkWarnings.push(
            `Renamed the folder to "${toName}", but its SKILL.md could not be updated — edit the frontmatter to match.`,
          );
        }
      }
      return { ok: true, warnings: forkWarnings };
    },

    async applyAddRemove(input) {
      const { scope, name, inPlaceEntry } = input;
      const inPlaceScanBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const rootAdds: string[] = [];
      const rootRemoves: string[] = [];
      const stripHome = (id: string) => id.replace(/\\/g, '/').replace(/^~\//, '');
      const sourceId = inPlaceEntry.hosts[0];
      if (sourceId !== undefined && (input.remove ?? []).some((id) => stripHome(id) === sourceId)) {
        return { ok: false, kind: 'remove-source', sourceId };
      }
      const hostSet = new Set(inPlaceEntry.hosts.filter((h) => isSkillInstallTarget(h)));
      for (const id of input.add ?? []) {
        if (isSkillInstallTarget(id)) hostSet.add(id);
        else rootAdds.push(stripHome(id));
      }
      const aliasMap = scanHostRootAliases(inPlaceScanBase, scope);
      const aliasUnfollows: string[] = [];
      const aliasMaterializes: string[] = [];
      for (const id of input.add ?? []) {
        if (
          isSkillInstallTarget(id) &&
          aliasMap[id] !== undefined &&
          !existsSync(resolve(inPlaceScanBase, aliasMap[id], name, 'SKILL.md'))
        ) {
          const subRoot =
            id === 'agents'
              ? AGENTS_SKILLS_ROOT
              : ((scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT)[
                  id as EditorId
                ] ?? null);
          if (subRoot !== null) aliasMaterializes.push(subRoot);
        }
      }
      for (const id of input.remove ?? []) {
        if (isSkillInstallTarget(id)) {
          if (
            !hostSet.has(id) &&
            aliasMap[id] !== undefined &&
            existsSync(resolve(inPlaceScanBase, aliasMap[id], name, 'SKILL.md'))
          ) {
            const subRoot =
              id === 'agents'
                ? AGENTS_SKILLS_ROOT
                : ((scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT)[
                    id as EditorId
                  ] ?? null);
            if (subRoot !== null) aliasUnfollows.push(subRoot);
          }
          hostSet.delete(id);
        } else rootRemoves.push(stripHome(id));
      }
      for (const { subRoot, exclude } of [
        ...aliasMaterializes.map((subRoot) => ({ subRoot, exclude: undefined })),
        ...aliasUnfollows.map((subRoot) => ({ subRoot, exclude: [name] })),
      ]) {
        const r = unlinkEditorSkillFolder({
          base: inPlaceScanBase,
          folderRel: subRoot,
          ...(exclude !== undefined ? { exclude } : {}),
        });
        if (r.ok) await recordFolderExpectation(inPlaceScanBase, subRoot, { expect: 'own' });
        if (!r.ok) {
          return { ok: false, kind: 'unfollow-failed', subRoot, reason: r.reason };
        }
      }
      return { ok: true, targets: [...hostSet], rootAdds, rootRemoves };
    },

    async promoteStoreBackedSource(input) {
      const { scope, name, base, skillDir, newSource } = input;
      const inPlaceScanBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const moved = relocateInPlaceCanonical({
        canonicalAbs: skillDir,
        canonicalHash: parseSkillDir(skillDir)?.contentHash ?? '',
        name,
        cwd: inPlaceScanBase,
        newTarget: newSource,
        roots: skillProjectionRoots(scope),
      });
      if (!moved.ok) {
        return { ok: false, kind: 'source-occupied', reason: moved.reason };
      }
      await removeSkillInstall(base, name);
      await recordSkillSourceHost(inPlaceScanBase, name, newSource);
      const postPromote = scanScope(scope).find((s) => s.name === name);
      return {
        ok: true,
        hosts: postPromote ? [...postPromote.hosts] : [],
        sourceMovedTo: relative(inPlaceScanBase, moved.newAbs).split(sep).join('/'),
      };
    },

    async promoteInPlaceSource(input) {
      const { scope, name, base, prefBase, skillDir, inPlaceEntry, newSource } = input;
      const inPlaceScanBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const ledgerBase = prefBase ?? base;
      const currentSource = inPlaceEntry.hosts[0] as string | undefined;
      const isHostTarget = isSkillInstallTarget(newSource);
      let customDestAbs: string | undefined;
      if (!isHostTarget) {
        const rel = newSource
          .replace(/\\/g, '/')
          .replace(/^~\//, '')
          .replace(/^\/+|\/+$/g, '');
        const invalidOk = isRefusedOkPlacementRoot(rel);
        const destAbs = resolve(base, rel, name);
        if (rel === '' || invalidOk || !destAbs.startsWith(resolve(base) + sep)) {
          return { ok: false, kind: 'invalid-target', target: newSource };
        }
        customDestAbs = destAbs;
      }
      let sourceMovedTo: string | undefined;
      if (currentSource !== undefined && newSource !== currentSource) {
        const oldSourceRel = relative(inPlaceScanBase, resolve(skillDir)).split(sep).join('/');
        const moved = relocateInPlaceCanonical({
          canonicalAbs: skillDir,
          canonicalHash: inPlaceEntry.contentHash,
          name,
          cwd: base,
          newTarget: (isHostTarget ? newSource : 'agents') as SkillHostId,
          ...(customDestAbs !== undefined ? { destDirAbs: customDestAbs } : {}),
          leaveLinkBehind: true,
          roots: skillProjectionRoots(scope),
        });
        if (!moved.ok) {
          return { ok: false, kind: 'source-occupied', reason: moved.reason };
        }
        sourceMovedTo = relative(inPlaceScanBase, moved.newAbs).split(sep).join('/');
        const oldSourceAbs = resolve(inPlaceScanBase, oldSourceRel);
        const siblingForm = deps.effectiveInstallMode(scope, name, {
          hosts: inPlaceEntry.hosts,
          linkedHosts: inPlaceEntry.linkedHosts ?? [],
        });
        if (siblingForm === 'copy') {
          try {
            if (lstatSync(oldSourceAbs).isSymbolicLink()) {
              tracedRmSync(oldSourceAbs, { recursive: true, force: true });
              tracedCpSync(moved.newAbs, oldSourceAbs, { recursive: true, dereference: true });
            }
          } catch {}
        }
        let oldSourceIsLink = false;
        try {
          oldSourceIsLink = lstatSync(oldSourceAbs).isSymbolicLink();
        } catch {
          oldSourceIsLink = true;
        }
        await recordSkillPlacement(
          ledgerBase,
          name,
          oldSourceIsLink
            ? { path: oldSourceRel, mode: 'link' }
            : { path: oldSourceRel, mode: 'copy', hash: inPlaceEntry.contentHash },
        );
        const hostOwned = new Set(
          hostSlotPaths(base, name, skillProjectionRoots(scope)).map((p) => resolve(p)),
        );
        repointSiblingLinks({
          name,
          cwd: base,
          roots: skillProjectionRoots(scope),
          target: moved.newAbs,
          slots: (readSkillPlacements(ledgerBase)[name] ?? [])
            .map((pl) => resolve(ledgerBase, pl.path))
            .filter((abs) => !hostOwned.has(abs)),
          skip: [moved.newAbs, resolve(skillDir)],
          alsoClaim: [resolve(skillDir), moved.newAbs],
        });
        await recordSkillPlacement(ledgerBase, name, {
          path: sourceMovedTo,
          mode: 'copy',
        });
        await recordSkillSourceHost(ledgerBase, name, newSource);
      }
      const postMove = scanScope(scope).find((sk) => sk.name === name);
      return {
        ok: true,
        hosts: postMove ? [...postMove.hosts] : [...inPlaceEntry.hosts],
        ...(sourceMovedTo !== undefined ? { sourceMovedTo } : {}),
      };
    },

    async fanOutInPlace(input) {
      const { scope, name, base, prefBase, inPlaceEntry, inPlaceTargets } = input;
      const inPlaceScanBase = scope === 'project' ? deps.contentDir : deps.skillsHome;
      const ledgerBase = prefBase ?? base;
      let { skillDir } = input;
      const warnings: string[] = [];
      const warningCodes: SkillInstallWarningCode[] = [];

      const prior = inPlaceEntry.hosts.filter((h): h is SkillHostId => isSkillInstallTarget(h));
      const sourceHost = inPlaceEntry.hosts[0] as SkillHostId | undefined;
      let sourceMovedTo: string | undefined;
      if (
        input.setExact &&
        sourceHost !== undefined &&
        !sourceHost.includes('/') &&
        inPlaceTargets.length > 0 &&
        !inPlaceTargets.includes(sourceHost)
      ) {
        const newTarget = inPlaceTargets[0] as SkillHostId;
        const moved = relocateInPlaceCanonical({
          canonicalAbs: skillDir,
          canonicalHash: inPlaceEntry.contentHash,
          name,
          cwd: base,
          newTarget,
          roots: skillProjectionRoots(scope),
        });
        if (!moved.ok) {
          return { ok: false, kind: 'source-occupied', reason: moved.reason };
        }
        skillDir = moved.newAbs;
        sourceMovedTo = relative(inPlaceScanBase, moved.newAbs).split(sep).join('/');
        await recordSkillPlacement(ledgerBase, name, {
          path: sourceMovedTo,
          mode: 'copy',
        });
        await recordSkillSourceHost(ledgerBase, name, newTarget);
      }
      const effectiveRootRel = sourceMovedTo
        ? sourceMovedTo.split('/').slice(0, -1).join('/')
        : input.canonicalRootRel;

      removeInPlaceSkillCopies({
        canonicalAbs: skillDir,
        canonicalHash: inPlaceEntry.contentHash,
        name,
        cwd: base,
        targets: input.setExact ? prior.filter((h) => !inPlaceTargets.includes(h)) : [],
        roots: skillProjectionRoots(scope),
      });
      const fanned = projectInPlaceSkill({
        canonicalAbs: skillDir,
        canonicalHash: inPlaceEntry.contentHash,
        canonicalRootRel: effectiveRootRel,
        name,
        cwd: base,
        targets: inPlaceTargets,
        mode: input.installMode,
        convertLinks: input.linkModeReq === false,
        convertCopies: input.linkModeReq === true,
        roots: skillProjectionRoots(scope),
      });
      for (const editor of fanned.conflicted) {
        warnings.push(
          `A different skill named "${name}" already exists in the ${editor} skills folder — left untouched.`,
        );
        warningCodes.push('name-conflict');
      }
      if (input.linkModeReq !== undefined && prefBase && input.rootAdds.length > 0) {
        const adding = new Set(input.rootAdds.map((r) => `${r}/${name}`));
        for (const p of (readSkillPlacements(prefBase)[name] ?? []).filter((p) =>
          adding.has(p.path),
        )) {
          const abs = resolve(prefBase, p.path);
          if (abs === resolve(skillDir)) continue;
          const cls = classifyInPlaceDest(abs, resolve(skillDir), inPlaceEntry.contentHash);
          if (input.linkModeReq === true && cls === 'same-copy') {
            tracedRmSync(abs, { recursive: true, force: true });
            tracedSymlinkSync(relative(dirname(abs), resolve(skillDir)), abs, 'dir');
            await recordSkillPlacement(prefBase, name, { path: p.path, mode: 'link' });
          } else if (input.linkModeReq === false && cls === 'link-to-canonical') {
            tracedRmSync(abs, { recursive: true, force: true });
            tracedCpSync(resolve(skillDir), abs, { recursive: true, dereference: true });
            await recordSkillPlacement(prefBase, name, {
              path: p.path,
              mode: 'copy',
              hash: inPlaceEntry.contentHash,
            });
          }
        }
      }

      for (const editor of fanned.hosts) {
        const editorRoot =
          editor === 'agents' ? AGENTS_SKILLS_ROOT : EDITOR_PROJECT_SKILL_ROOT[editor];
        if (editorRoot === null || editorRoot === input.canonicalRootRel) continue;
        const copyAbs = resolve(base, editorRoot, name);
        let isLink = false;
        try {
          isLink = lstatSync(copyAbs).isSymbolicLink();
        } catch {
          continue;
        }
        if (isLink) {
          if (input.installMode === 'link') {
            await recordSkillPlacement(ledgerBase, name, {
              path: `${editorRoot}/${name}`,
              mode: 'link',
            });
          }
          continue;
        }
        const copyHash = existsSync(join(copyAbs, 'SKILL.md'))
          ? parseSkillDir(copyAbs)?.contentHash
          : undefined;
        if (copyHash !== undefined && copyHash === inPlaceEntry.contentHash) {
          await recordSkillPlacement(ledgerBase, name, {
            path: `${editorRoot}/${name}`,
            mode: 'copy',
            hash: copyHash,
          });
        }
      }
      if ((input.rootAdds.length > 0 || input.rootRemoves.length > 0) && prefBase) {
        const canonAbs = resolve(skillDir);
        for (const rootRel of input.rootAdds) {
          const underOk = isRefusedOkPlacementRoot(rootRel);
          const parentAbs = resolve(prefBase, rootRel);
          const destAbs = resolveSkillPlacementPath(prefBase, `${rootRel}/${name}`);
          if (rootRel === '' || underOk || destAbs === null || destAbs === canonAbs) {
            warnings.push(`"${rootRel}" is not a placeable custom root — skipped.`);
            warningCodes.push('place-path-invalid');
            continue;
          }
          const cls = classifyInPlaceDest(destAbs, canonAbs, inPlaceEntry.contentHash);
          if (cls === 'different') {
            warnings.push(`A different "${name}" already exists at ${rootRel} — left untouched.`);
            warningCodes.push('name-conflict');
            continue;
          }
          if (cls === 'absent') {
            tracedMkdirSync(parentAbs, { recursive: true });
            if (input.installMode === 'link') {
              tracedSymlinkSync(relative(parentAbs, canonAbs), destAbs, 'dir');
            } else {
              tracedCpSync(canonAbs, destAbs, { recursive: true, dereference: true });
            }
          }
          await recordSkillPlacement(prefBase, name, {
            path: `${rootRel}/${name}`,
            mode: input.installMode,
            ...(input.installMode === 'copy' ? { hash: inPlaceEntry.contentHash } : {}),
          });
        }
        for (const rootRel of input.rootRemoves) {
          const rel = `${rootRel}/${name}`;
          const recorded = readSkillPlacements(prefBase)[name]?.find((pl) => pl.path === rel);
          const absDir = resolveSkillPlacementPath(prefBase, rel);
          if (absDir === null) {
            warnings.push(`"${rootRel}" is not a placeable custom root — skipped.`);
            warningCodes.push('place-path-invalid');
            continue;
          }
          const cls = classifyInPlaceDest(absDir, canonAbs, inPlaceEntry.contentHash);
          if (cls === 'different') {
            warnings.push(
              `The copy at ${rel} has been hand-edited (a fork) — refused, never deleted. Remove it manually if you mean it.`,
            );
            warningCodes.push('place-fork-refused');
            continue;
          }
          if (cls !== 'absent' && cls !== 'canonical-dir') {
            tracedRmSync(absDir, { recursive: true, force: true });
          }
          if (recorded) await removeSkillPlacement(prefBase, name, rel);
        }
      }

      const postEntry = scanScope(scope).find((s) => s.name === name);
      const hosts = postEntry ? [...postEntry.hosts] : fanned.hosts;
      return {
        ok: true,
        hosts,
        warnings,
        warningCodes,
        ...(sourceMovedTo !== undefined ? { sourceMovedTo } : {}),
      };
    },
  };
}
