import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readSkillManifestMeta } from '../manifest-meta.ts';
import type { SkillInert, SkillProvenance } from '../schema.ts';

export interface RawSkill {
  readonly name: string;
  readonly description: string;
  readonly home: string;
  readonly harness: string;
  readonly skillMd: string;
  readonly scripts: string[];
  readonly references: string[];
  readonly provenance: SkillProvenance;
  readonly inert: SkillInert;
}

export interface SkillBundle {
  readonly packName: string;
  readonly packVersion: string;
  readonly packDescription?: string;
  readonly packAuthor?: string;
  readonly harness: string;
  readonly skills: RawSkill[];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch {
    return [];
  }
}

export function readSkillDir(
  dir: string,
  harness: string,
  provenance: SkillProvenance,
  inert: SkillInert,
): RawSkill | null {
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  const dirName = basename(dir);
  let name = dirName;
  let description = '';
  try {
    ({ name, description } = readSkillManifestMeta(readFileSync(skillMd, 'utf-8'), dirName));
  } catch {}
  return {
    name,
    description,
    home: dir,
    harness,
    skillMd,
    scripts: listFiles(join(dir, 'scripts')),
    references: listFiles(join(dir, 'references')),
    provenance,
    inert,
  };
}

export function skillDirNames(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function detectInert(bundleRoot: string): SkillInert {
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return {
    commands: isDir(join(bundleRoot, 'commands')),
    hooks: isDir(join(bundleRoot, 'hooks')),
    mcp: existsSync(join(bundleRoot, '.mcp.json')),
  };
}

export const NO_INERT: SkillInert = { commands: false, hooks: false, mcp: false };
