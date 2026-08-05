import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
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

/**
 * Skill-install verbs that reshape a skill's real locations (as opposed to
 * the placement ledger verbs in skill-placement-ops.ts). First resident:
 * fork resolution — same name, different bytes in a non-canonical editor
 * dir. Every path stashes the bytes it discards to
 * `~/.ok/edit-backups/forks/` first — resolution is never silently lossy.
 */

const log = getLogger('skill-install');

/** The canonical in-place entry a fork is resolved against. */
interface ForkCanonical {
  dir: string;
  contentHash: string;
  hosts: readonly string[];
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
}

export interface SkillInstallOpsService {
  resolveFork(input: {
    scope: 'project' | 'global';
    name: string;
    fork: { editor: string; action: 'align' | 'make-source' | 'rename'; toName?: string };
    inPlaceEntry: ForkCanonical;
  }): ResolveForkOutcome;
  /**
   * Additive `add`/`remove` (stateless location callers): translate into the
   * set-exact host math + custom-root placement lists, applying the alias
   * materialize/unfollow remedies so one verb means "this agent gets / stops
   * getting the skill" however its folder is wired.
   */
  applyAddRemove(input: {
    scope: 'project' | 'global';
    name: string;
    inPlaceEntry: ForkCanonical;
    add?: readonly string[];
    remove?: readonly string[];
  }): Promise<ApplyAddRemoveOutcome>;
  /**
   * SOURCE promotion for a STORE-BACKED skill: the chosen host's location
   * becomes the real folder, sibling symlinks re-point, the install-marker
   * entry drops (the in-place scan is truth from here on), and the choice is
   * sticky.
   */
  promoteStoreBackedSource(input: {
    scope: 'project' | 'global';
    name: string;
    base: string;
    skillDir: string;
    newSource: SkillHostId;
  }): Promise<PromoteSourceOutcome>;
  /**
   * One-shot SOURCE move for an IN-PLACE skill: relocate the real folder to
   * the chosen host (editor id, the hub, or a custom skills root) and leave a
   * symlink at the old source path — set-source is never a removal.
   */
  promoteInPlaceSource(input: {
    scope: 'project' | 'global';
    name: string;
    base: string;
    prefBase?: string;
    skillDir: string;
    inPlaceEntry: ForkCanonical;
    newSource: string;
  }): Promise<PromoteSourceOutcome>;
  /**
   * Set-exact fan-out for an IN-PLACE skill: relocate the source when it was
   * explicitly unchecked, strip lossless copies the target set no longer
   * names, project into newly-checked hosts, convert named custom placements
   * to the requested form, record receipts, and apply additive custom-root
   * adds/removes. Returns the honest post-op host set from a re-scan.
   */
  fanOutInPlace(input: {
    scope: 'project' | 'global';
    name: string;
    /** cwd host dirs resolve against; also where the install marker lives. */
    base: string;
    /** Placement-ledger base (per-skill preference scope); absent in harnesses. */
    prefBase?: string;
    skillDir: string;
    inPlaceEntry: ForkCanonical;
    canonicalRootRel: string;
    inPlaceTargets: SkillHostId[];
    /** True when the caller named an explicit target set (set-exact semantics). */
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
      // Warnings raised while resolving a fork — surfaced on the response so a
      // half-completed rename is not reported as a clean success.
      const forkWarnings: string[] = [];
      const rootMap = scope === 'project' ? EDITOR_PROJECT_SKILL_ROOT : EDITOR_USER_SKILL_ROOT;
      const forkRootRel =
        fork.editor === 'agents' ? '.agents/skills' : (rootMap[fork.editor as EditorId] ?? null);
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
        // The fork loses: stash it, remove it, re-project the canonical.
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
        // The fork wins: stash + remove the old canonical and its same-hash
        // copies; the fork's dir is then the only real dir and the scan
        // elects it; re-project to the hosts the skill had.
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
        // Keep both: the fork's dir becomes an independent skill under a
        // NEW name (frontmatter rewritten in lock-step with the dir).
        const toName = fork.toName as string;
        if (!SKILL_NAME_REGEX.test(toName)) {
          return { ok: false, kind: 'invalid-new-name', toName };
        }
        if (scanScope(scope).some((sk) => sk.name === toName)) {
          return { ok: false, kind: 'name-taken', toName };
        }
        const dest = resolve(inPlaceScanBase, forkRootRel, toName);
        tracedRenameSync(forkDir, dest);
        // The folder move already happened. If the frontmatter patch below
        // fails the skill is left half-renamed, which the caller has to
        // hear about — a 200 with no warnings reads as a clean rename.
        const skillMdPath = resolve(dest, 'SKILL.md');
        try {
          // Patch the YAML region, not the file. A multiline `^name:` regex
          // matches the first such line ANYWHERE, so a body line reading
          // `name: …` (a code sample, a config snippet) got rewritten
          // instead of the frontmatter. Same primitives the duplicate
          // handler uses.
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
      // The source is untouchable here — a skill's source folder IS the
      // skill; removing it is `delete`, moving it is `source`.
      if (sourceId !== undefined && (input.remove ?? []).some((id) => stripHome(id) === sourceId)) {
        return { ok: false, kind: 'remove-source', sourceId };
      }
      const hostSet = new Set(inPlaceEntry.hosts.filter((h) => isSkillInstallTarget(h)));
      for (const id of input.add ?? []) {
        if (isSkillInstallTarget(id)) hostSet.add(id);
        else rootAdds.push(stripHome(id));
      }
      // A removed host that is NOT a physical location but READS the skill
      // through a folder alias (its skills folder symlinked into a pool
      // root holding the skill) gets the unfollow remedy automatically:
      // its folder unlinks from the pool EXCLUDING this skill — one verb
      // means "this agent stops getting the skill" however it got it.
      const aliasMap = scanHostRootAliases(inPlaceScanBase, scope);
      const aliasUnfollows: string[] = [];
      // The ADD-side mirror: an added host whose skills folder is an alias
      // into a pool that does NOT hold this skill would otherwise be a
      // silent no-op (projection never writes through an alias). One verb
      // means "this agent gets the skill" however its folder is wired — so
      // the alias unlinks into per-skill links first (keeping everything it
      // followed), and the projection below then writes the real bundle.
      const aliasMaterializes: string[] = [];
      for (const id of input.add ?? []) {
        if (
          isSkillInstallTarget(id) &&
          aliasMap[id] !== undefined &&
          !existsSync(resolve(inPlaceScanBase, aliasMap[id], name, 'SKILL.md'))
        ) {
          const subRoot =
            id === 'agents'
              ? '.agents/skills'
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
                ? '.agents/skills'
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
      // Editor ids + the hub map to host dirs; anything else is a CUSTOM
      // skills-root path (its synthetic host id IS the root path).
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
          // The promote/downgrade SWAP: the old source path becomes a
          // symlink to the new one (set-source is never a removal).
          leaveLinkBehind: true,
          roots: skillProjectionRoots(scope),
        });
        if (!moved.ok) {
          return { ok: false, kind: 'source-occupied', reason: moved.reason };
        }
        sourceMovedTo = relative(inPlaceScanBase, moved.newAbs).split(sep).join('/');
        // The swap left a symlink at the old source path (relocate's
        // `leaveLinkBehind`). RECORD it as the expected form — without
        // the receipt, an external tool rewriting that link as a copy
        // would be invisible to drift detection (the .agents blind spot).
        await recordSkillPlacement(ledgerBase, name, {
          path: oldSourceRel,
          mode: 'link',
        });
        // Re-point recorded placement SYMLINKS that referenced the old
        // source: `relocateInPlaceCanonical`'s own sweep only walks host dirs,
        // so the ledger is a second slot source over the same relocation. Both
        // run the shared spine with the same claim + skip sets, because two
        // sweeps of one relocation disagreeing is how a link or a directory the
        // other was written to preserve gets deleted.
        //
        // The ledger records host slots too, so the two slot sources OVERLAP.
        // Excluding the host-owned ones is what keeps a sibling host link from
        // being unlinked and rebuilt here microseconds after the host sweep
        // wrote it correctly -- byte-identical, tree-invisible, and exactly the
        // scar `skip` exists to avoid on the slots this sweep does own.
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
        // The promoted path is now the REAL dir — refresh its receipt to
        // the promoted form (hash-less copy: no drift, resync skips it,
        // and a custom root stays registered with the scan). A leftover
        // 'link' expectation would misread the promotion as drift
        // (OVERWRITTEN on a folder OK itself just wrote), inviting an
        // accidental hands-off.
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
      // Unchecking THE SOURCE relocates it: the bundle moves to the
      // highest-precedence remaining target (its copy/link there becomes
      // the real dir), sibling links re-point, and set-exact proceeds
      // against the new source. Refused when no other target remains —
      // removing the only location is delete, not uninstall.
      // `targets: []` (uninstall everywhere) is NOT a relocation request:
      // lossless copies strip below and the source survives, matching the
      // never-delete invariant.
      // A CUSTOM-ROOT source (path-like host id, e.g. `.ok/skills`) is
      // inexpressible in the editor-checkbox target vocabulary, so its
      // absence from a set-exact list is NOT an uncheck — a mode flip
      // (Copies/Symlinks re-apply) must never relocate it. Only an
      // editor/hub source can be unchecked, and only that relocates.
      // Relocation needs an EXPLICIT uncheck. With `targets` omitted the
      // caller expressed no opinion about membership at all — the list came
      // from `resolveSkillTargets`, which never includes the `agents` hub, so
      // a defaults-driven call would read the hub's absence as an uncheck and
      // move the real folder out from under it. Same reasoning as the two
      // carve-outs above: `targets: []` and a custom-root source are excluded
      // because neither is an uncheck either.
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
        // The path holding the source is now the REAL dir — a stale 'link'
        // receipt there would misread the relocation as drift.
        await recordSkillPlacement(ledgerBase, name, {
          path: sourceMovedTo,
          mode: 'copy',
        });
        // Sticky: without this the next scan re-elects the source by
        // static precedence and the user's choice silently reverts.
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
        // Set-exact removal only when the caller actually named a set. With
        // `targets` omitted this call is additive ("make sure it is in my
        // configured editors"), so subtracting the locations that list
        // happens not to mention would delete work nobody asked to remove.
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
        // An EXPLICIT copy choice converts existing links back to copies
        // (lossless — the link's bytes ARE the canonical's); an implicit
        // copy default never touches links.
        convertLinks: input.linkModeReq === false,
        roots: skillProjectionRoots(scope),
      });
      for (const editor of fanned.conflicted) {
        warnings.push(
          `A different skill named "${name}" already exists in the ${editor} skills folder — left untouched.`,
        );
        warningCodes.push('name-conflict');
      }
      // Custom placements the call is ADDING adopt the requested form; ones
      // it does not name are left alone. A blanket flip of every recorded
      // placement as a side effect of installing is exactly what the app
      // retired — converting is its own verb, per location, and asks first.
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

      // Record what we just WROTE (machine-local): copies so the forward
      // re-sync can lossless-refresh them, links as the EXPECTED form so
      // drift detection can spot another tool rewriting the path.
      for (const editor of fanned.hosts) {
        const editorRoot =
          editor === 'agents' ? '.agents/skills' : EDITOR_PROJECT_SKILL_ROOT[editor];
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
      // ── Additive custom-root placements (path-like `add`/`remove`
      // members). Idempotent: an already-satisfied add is a no-op; a
      // hand-edited fork is refused with a warning, never deleted.
      if ((input.rootAdds.length > 0 || input.rootRemoves.length > 0) && prefBase) {
        const canonAbs = resolve(skillDir);
        for (const rootRel of input.rootAdds) {
          const underOk = isRefusedOkPlacementRoot(rootRel);
          const parentAbs = resolve(prefBase, rootRel);
          // Symlink-aware containment, the same resolver `place` / `unplace`
          // / `convert` use. A lexical `startsWith` prefix test walks
          // straight through a checked-in symlink (`.team ->
          // ~/Library/LaunchAgents`), and the mkdir + cp below would then
          // write the bundle outside the project entirely.
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

      // Report the FULL honest post-op host set by re-scanning — covers
      // hub adds/removes, canonical-protection skips, and capability-covered
      // hosts, so the client's before/after diff never invents changes.
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
