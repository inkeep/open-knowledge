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
import { isPluginEnabled } from './required-plugins.ts';
import { DEFAULT_PACK_ID, resolvePack, STARTER_FOLDER_FRONTMATTER_FILENAME } from './starter.ts';
import type { FileEntry, ScaffoldPlan, SeedOptions, SkipEntry } from './types.ts';
import { SeedPrerequisiteError, SeedRootDirError } from './types.ts';

function frontmatterTemplateId(folderPath: string): string {
  return `${folderPath}/.ok/frontmatter.yml`;
}

function templateFileTemplateId(folderPath: string, templateName: string): string {
  return `${folderPath}/.ok/templates/${templateName}.md`;
}

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
  assertEntryPathInProject(projectDir, posix);
  return posix;
}

function joinRelative(root: string, path: string): string {
  return root === '' ? path : `${root}/${path}`;
}

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

  if (rootDir !== '') {
    const rootPath = join(projectDir, rootDir);
    if (!existsSync(rootPath)) {
      created.push({ path: rootDir, kind: 'folder' });
    } else {
      skipped.push({ path: rootDir, reason: 'already-exists' });
    }
  }

  for (const folder of pack.folders) {
    const folderPath = joinRelative(rootDir, folder.path);
    const folderAbs = join(projectDir, folderPath);
    if (existsSync(folderAbs)) {
      skipped.push({ path: folderPath, reason: 'already-exists' });
    } else {
      created.push({ path: folderPath, kind: 'folder' });
    }

    const okSubDir = `${folderPath}/.ok`;
    const okSubAbs = join(projectDir, okSubDir);
    if (existsSync(okSubAbs)) {
      skipped.push({ path: okSubDir, reason: 'already-exists' });
    } else {
      created.push({ path: okSubDir, kind: 'folder' });
    }

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

    const tplDir = `${okSubDir}/templates`;
    const tplDirAbs = join(projectDir, tplDir);
    if (existsSync(tplDirAbs)) {
      skipped.push({ path: tplDir, reason: 'already-exists' });
    } else {
      created.push({ path: tplDir, kind: 'folder' });
    }

    const templatesToInstall = [folder.starterTemplate, ...(folder.extraTemplates ?? [])];
    for (const templateName of templatesToInstall) {
      const tplFile = `${tplDir}/${templateName}.md`;
      const tplFileAbs = join(projectDir, tplFile);
      if (existsSync(tplFileAbs)) {
        skipped.push({ path: tplFile, reason: 'already-exists' });
        continue;
      }
      if (pack.templates[templateName] === undefined) {
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

  const sources = resolvePackSkillSources(pack.id);
  const home = sources.length > 0 ? resolvePackSkillHome(projectDir) : null;
  const homeRefusal: PackSkillHomeRefusal | undefined =
    home !== null && 'refusal' in home ? home.refusal : undefined;
  const scan = sources.length > 0 ? scanInPlaceSkills(projectDir) : [];
  const inPlaceDirByName = new Map(scan.map((sk) => [sk.name, join(projectDir, sk.dir)]));
  const lock = sources.length > 0 ? readSkillsLockFile(join(projectDir, ...SKILLS_LOCK_REL)) : null;
  const packSkills = sources.map(({ name }) => {
    const storeDir = join(projectDir, '.ok', 'skills', name);
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
    const presentName =
      inPlaceDirByName.has(name) || legacyDir === null ? name : (legacyName as string);
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

  const requiredPlugins = (pack.requiredPlugins ?? []).map((id) => ({
    id,
    pending: !isPluginEnabled(projectDir, id),
  }));

  return {
    created,
    skipped,
    warnings,
    ...(packSkills.length > 0 ? { packSkills } : {}),
    ...(requiredPlugins.length > 0 ? { requiredPlugins } : {}),
    ...(packSkills.length > 0 && homeRefusal !== undefined
      ? { packSkillHomeRefusal: homeRefusal }
      : {}),
  };
}
