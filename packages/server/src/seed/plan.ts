import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OK_PROJECT_MARKER } from '@inkeep/open-knowledge-core';
import { SKILLS_LOCK_REL } from '@inkeep/open-knowledge-core/skills-catalog';
import { isProjectRoot } from '../fs/find-project-root.ts';
import { scanInPlaceSkills } from '../in-place-skills.ts';
import { readSkillsLockFile } from '../skills-lock-store.ts';
import {
  classifyPresentPackSkill,
  OLD_PACK_SKILL_NAME,
  type PackSkillHomeRefusal,
  resolvePackSkillHome,
  resolvePackSkillSources,
} from './install-pack-skill.ts';
import { assertEntryPathInProject } from './path-safety.ts';
import { DEFAULT_PACK_ID, resolvePack, STARTER_FOLDER_FRONTMATTER_FILENAME } from './starter.ts';
import type { FileEntry, ScaffoldPlan, SeedOptions, SkipEntry } from './types.ts';
import { SeedPrerequisiteError, SeedRootDirError } from './types.ts';

/** Stable template ids for the nested `.ok/` writes per starter folder. */
function frontmatterTemplateId(folderPath: string): string {
  return `${folderPath}/.ok/frontmatter.yml`;
}

function templateFileTemplateId(folderPath: string, templateName: string): string {
  return `${folderPath}/.ok/templates/${templateName}.md`;
}

/**
 * Normalize a user-supplied rootDir to a POSIX-style relative path with no
 * trailing slash. `.` and `''` both collapse to `''` (= project-root scaffold,
 * historical behavior).
 *
 * String-shape checks reject the obvious bad inputs (absolute paths, `..`
 * segments). After normalization the path runs through `assertEntryPathInProject`
 * which adds two further guards: a lexical `resolve(...).startsWith(projectAbs+sep)`
 * containment check (catches Windows UNC paths, drive-letter forms, any input
 * whose joined resolve lands outside projectDir) and a `realpathSync` walk-up
 * that rejects pre-existing symlinks redirecting into the rootDir's path
 * (`brain -> /etc` — applied paths would otherwise follow the symlink at
 * writeFileSync time).
 */
function normalizeRootDir(rootDir: string | undefined, projectDir: string): string {
  if (!rootDir) return '';
  const trimmed = rootDir.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return '';
  if (trimmed.startsWith('/')) {
    throw new SeedRootDirError(
      `rootDir must be relative to the project directory, got: ${rootDir}`,
    );
  }
  const posix = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (posix.split('/').some((seg) => seg === '..')) {
    throw new SeedRootDirError(`rootDir must not contain '..' segments, got: ${rootDir}`);
  }
  // Lexical containment + realpath symlink-escape guard. Re-throws any
  // SeedRootDirError from the helper as-is; the helper's messages reference
  // "entry path" rather than rootDir specifically, but the caller always
  // distinguishes the surface (planSeed swallows + maps to invalid-root).
  assertEntryPathInProject(projectDir, posix);
  return posix;
}

function joinRelative(root: string, path: string): string {
  return root === '' ? path : `${root}/${path}`;
}

/**
 * Compute a ScaffoldPlan for the given project. Read-only — performs no writes.
 *
 * Throws `SeedPrerequisiteError` if `.ok/config.yml` is absent — the user must
 * run `ok init` first. The marker is the config file, not the `.ok/` directory:
 * nested folder-rule writes (via `write`/`edit` folder targets) create
 * `<folder>/.ok/` subdirectories with no `config.yml`, and a looser gate would
 * accept them as project roots.
 *
 * For each starter folder in the selected pack (`opts.packId`, default
 * `'knowledge-base'`) this plans:
 *   1. The folder itself.
 *   2. The nested `.ok/` directory.
 *   3. The nested `.ok/frontmatter.yml` carrying the folder defaults.
 *   4. The nested `.ok/templates/` directory.
 *   5. One starter template + zero-or-more extra templates inside
 *      `.ok/templates/<name>.md` — keyed off `StarterFolder.starterTemplate`
 *      and `StarterFolder.extraTemplates` respectively. All share the same
 *      template directory; the starter is what the picker pre-selects.
 *
 * Plus any pack-specific root files (e.g. `log.md` for the Knowledge base pack).
 *
 * Existing files are skipped — never overwrite user edits.
 */
export async function planSeed(opts: SeedOptions = {}): Promise<ScaffoldPlan> {
  const projectDir = resolve(opts.projectDir ?? process.cwd());

  if (!opts.skipPrerequisite && !isProjectRoot(projectDir)) {
    throw new SeedPrerequisiteError(
      `No ${OK_PROJECT_MARKER} found at ${projectDir}. Run \`ok init\` first to scaffold the tool config.`,
    );
  }

  const rootDir = normalizeRootDir(opts.rootDir, projectDir);
  const pack = resolvePack(opts.packId ?? DEFAULT_PACK_ID);

  const created: FileEntry[] = [];
  const skipped: SkipEntry[] = [];
  const warnings: string[] = [];

  // 0. Root folder itself — when the user picked a subfolder (e.g. `brain/`),
  //    create it if missing so the pack's folders have a parent. When
  //    rootDir is '.' this is a no-op.
  if (rootDir !== '') {
    const rootPath = join(projectDir, rootDir);
    if (!existsSync(rootPath)) {
      created.push({ path: rootDir, kind: 'folder' });
    } else {
      skipped.push({ path: rootDir, reason: 'already-exists' });
    }
  }

  // 1. Pack folders + their nested `.ok/frontmatter.yml` + starter templates.
  //    Each gets independent existence checks so a partial scaffold (e.g. user
  //    deleted `external-sources/.ok/templates/clip.md` but kept the folder)
  //    fills in the missing piece without overwriting kept content.
  for (const folder of pack.folders) {
    const folderPath = joinRelative(rootDir, folder.path);
    const folderAbs = join(projectDir, folderPath);
    if (existsSync(folderAbs)) {
      skipped.push({ path: folderPath, reason: 'already-exists' });
    } else {
      created.push({ path: folderPath, kind: 'folder' });
    }

    // Nested `.ok/` for this starter folder.
    const okSubDir = `${folderPath}/.ok`;
    const okSubAbs = join(projectDir, okSubDir);
    if (existsSync(okSubAbs)) {
      skipped.push({ path: okSubDir, reason: 'already-exists' });
    } else {
      created.push({ path: okSubDir, kind: 'folder' });
    }

    // Nested `.ok/frontmatter.yml` — folder defaults.
    const fmPath = `${okSubDir}/${STARTER_FOLDER_FRONTMATTER_FILENAME}`;
    const fmAbs = join(projectDir, fmPath);
    if (existsSync(fmAbs)) {
      skipped.push({ path: fmPath, reason: 'already-exists' });
    } else {
      created.push({
        path: fmPath,
        kind: 'file',
        template: frontmatterTemplateId(folder.path),
      });
    }

    // Nested `.ok/templates/` directory + starter template.
    const tplDir = `${okSubDir}/templates`;
    const tplDirAbs = join(projectDir, tplDir);
    if (existsSync(tplDirAbs)) {
      skipped.push({ path: tplDir, reason: 'already-exists' });
    } else {
      created.push({ path: tplDir, kind: 'folder' });
    }

    // Starter template + any extras the folder declares. All share the same
    // `.ok/templates/` directory; the starter is what `New from template…`
    // pre-selects, extras are available alongside.
    const templatesToInstall = [folder.starterTemplate, ...(folder.extraTemplates ?? [])];
    for (const templateName of templatesToInstall) {
      const tplFile = `${tplDir}/${templateName}.md`;
      const tplFileAbs = join(projectDir, tplFile);
      if (existsSync(tplFileAbs)) {
        skipped.push({ path: tplFile, reason: 'already-exists' });
        continue;
      }
      if (pack.templates[templateName] === undefined) {
        // Starter missing = folder ships without its pre-selected template,
        // a meaningful UX defect. Extra missing = an optional variant is
        // unavailable but the folder still works. Differ the message so
        // agent flows can parse severity.
        const isStarter = templateName === folder.starterTemplate;
        warnings.push(
          isStarter
            ? `No starter template body registered for "${templateName}" in pack "${pack.id}". The folder will land without a pre-selected template.`
            : `No body registered for extra template "${templateName}" in pack "${pack.id}". The folder will land without that optional variant.`,
        );
        continue;
      }
      created.push({
        path: tplFile,
        kind: 'file',
        template: templateFileTemplateId(folder.path, templateName),
      });
    }
  }

  // 2. Optional pack root files (e.g. `log.md` for the Knowledge base pack).
  //    Each lives inside rootDir when set. Template id matches the filename so
  //    apply.ts can resolve it via pack.rootFiles[name].
  if (pack.rootFiles) {
    for (const filename of Object.keys(pack.rootFiles)) {
      const relPath = joinRelative(rootDir, filename);
      const absPath = join(projectDir, relPath);
      if (existsSync(absPath)) {
        skipped.push({ path: relPath, reason: 'already-exists' });
      } else {
        created.push({ path: relPath, kind: 'file', template: filename });
      }
    }
  }

  // 3. Pack skills. They are authored/installed by `applySeed` →
  //    `installPackSkill` (not `created` FileEntries — they're recursive dir
  //    copies), so report them separately: a project whose folders/templates exist
  //    but whose pack skill is absent (deleted, or a project seeded before
  //    skills-as-content) is NOT fully set up. Callers fold
  //    `packSkills[].pending` into "is there work to do?" alongside `created`.
  //    A decomposed pack ships several skills; each is pending independently.
  //    Presence is scan-based (in-place editor-dir skills, same source of truth
  //    `installPackSkill` dedups against), with the legacy `.ok/skills` store
  //    still honored for pre-inversion projects.
  //    Nothing is pending when the project has no usable skill home: OK never
  //    creates an agent folder, so `installPackSkill` declines and re-running
  //    the seed would change nothing. Reporting work that can never happen made
  //    every `ok seed` re-run in such a project claim it did something.
  const sources = resolvePackSkillSources(pack.id);
  const home = sources.length > 0 ? resolvePackSkillHome(projectDir) : null;
  const homeRefusal: PackSkillHomeRefusal | undefined =
    home !== null && 'refusal' in home ? home.refusal : undefined;
  const scan = sources.length > 0 ? scanInPlaceSkills(projectDir) : [];
  const inPlaceDirByName = new Map(scan.map((sk) => [sk.name, join(projectDir, sk.dir)]));
  const lock = sources.length > 0 ? readSkillsLockFile(join(projectDir, ...SKILLS_LOCK_REL)) : null;
  const packSkills = sources.map(({ name }) => {
    const storeDir = join(projectDir, '.ok', 'skills', name);
    // An install under the skill's OLD name is the same skill, kept under the
    // name its owner already knows (never renamed for them). `installPackSkill`
    // skips it, so the preview has to read it as present or dry-run promises an
    // install that apply declines.
    const legacyName = OLD_PACK_SKILL_NAME[name];
    const legacyDir =
      legacyName === undefined
        ? null
        : (inPlaceDirByName.get(legacyName) ??
          (existsSync(join(projectDir, '.ok', 'skills', legacyName, 'SKILL.md'))
            ? join(projectDir, '.ok', 'skills', legacyName)
            : null));
    const presentDir =
      inPlaceDirByName.get(name) ??
      legacyDir ??
      (existsSync(join(storeDir, 'SKILL.md')) ? storeDir : null);
    // Classify under the name the install actually HAS. A legacy install's lock
    // entry is keyed by its old name, so probing the lock with the shipped name
    // always misses and the verdict falls through to the frontmatter witness —
    // which the update path drops, at which point a skill that is provably ours
    // starts reporting as a stranger's name collision.
    const presentName =
      inPlaceDirByName.has(name) || legacyDir === null ? name : (legacyName as string);
    // A present same-named skill that is NOT ours by provenance is a name
    // collision, not "already seeded" — apply will skip it without clobbering,
    // so the preview must say so rather than show the pack as set up.
    const conflict =
      presentDir !== null &&
      lock !== null &&
      classifyPresentPackSkill(pack.id, presentName, presentDir, lock) === 'foreign';
    return {
      name,
      pending: presentDir === null && homeRefusal === undefined,
      ...(conflict ? { conflict: true } : {}),
    };
  });

  return {
    created,
    skipped,
    warnings,
    ...(packSkills.length > 0 ? { packSkills } : {}),
    ...(packSkills.length > 0 && homeRefusal !== undefined
      ? { packSkillHomeRefusal: homeRefusal }
      : {}),
  };
}
