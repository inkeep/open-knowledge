import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  SKILL_IMPORT_MAX_BUNDLE_FILES,
  SKILL_IMPORT_MAX_FILE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_BYTES,
} from '../import-limits.ts';
import { readSkillManifestMeta } from '../manifest-meta.ts';

const BUNDLE_WALK_IGNORE: ReadonlySet<string> = new Set(['.git', 'node_modules']);

const DISCOVER_WALK_IGNORE: ReadonlySet<string> = new Set([
  ...BUNDLE_WALK_IGNORE,
  'scripts',
  'references',
]);

export interface AcquiredFile {
  readonly relPath: string;
  readonly content: string | null;
  readonly bytes?: Uint8Array;
}

export interface AcquiredSkill {
  readonly name: string;
  readonly description: string;
  readonly skillMd: string;
  readonly files: AcquiredFile[];
  readonly contentHash: string;
}

function readBundleFiles(dir: string): AcquiredFile[] {
  const out: AcquiredFile[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (!BUNDLE_WALK_IGNORE.has(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const relPath = relative(dir, abs).split('\\').join('/');
      if (relPath === 'SKILL.md') continue;
      const buf = readFileSync(abs);
      out.push(
        buf.includes(0)
          ? { relPath, content: null, bytes: new Uint8Array(buf) }
          : { relPath, content: buf.toString('utf-8') },
      );
    }
  };
  walk(dir);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function readSkillDirMeta(dir: string): { name: string; description: string } | null {
  const skillMdPath = join(dir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  return readSkillManifestMeta(readFileSync(skillMdPath, 'utf-8'), basename(dir));
}

export function acquiredBundleTooLarge(dir: string): string | null {
  let files = 0;
  let totalBytes = 0;
  let failure: string | null = null;
  const refuse = (op: string, err: unknown): null => {
    failure = `Skill bundle could not be read (${op}): ${err instanceof Error ? err.message : String(err)}`;
    return null;
  };
  try {
    totalBytes = existsSync(join(dir, 'SKILL.md')) ? statSync(join(dir, 'SKILL.md')).size : 0;
  } catch (err) {
    return refuse('stat SKILL.md', err) ?? failure;
  }
  if (totalBytes > SKILL_IMPORT_MAX_FILE_BYTES) {
    return `SKILL.md is ${totalBytes} bytes; the import per-file cap is ${SKILL_IMPORT_MAX_FILE_BYTES}.`;
  }
  if (totalBytes > SKILL_IMPORT_MAX_TOTAL_BYTES) {
    return `Skill exceeds ${SKILL_IMPORT_MAX_TOTAL_BYTES} bytes; that is the import bundle cap.`;
  }
  const walk = (d: string): void => {
    if (failure !== null) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (err) {
      refuse('read directory', err);
      return;
    }
    for (const e of entries) {
      if (failure !== null) return;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (!BUNDLE_WALK_IGNORE.has(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const relPath = relative(dir, abs).split('\\').join('/');
      if (relPath === 'SKILL.md') continue;
      files += 1;
      if (files > SKILL_IMPORT_MAX_BUNDLE_FILES) {
        failure = `Skill has more than ${SKILL_IMPORT_MAX_BUNDLE_FILES} dependent files; that is the import cap.`;
        return;
      }
      let size: number;
      try {
        size = statSync(abs).size;
      } catch (err) {
        refuse(`stat ${relPath}`, err);
        return;
      }
      if (size > SKILL_IMPORT_MAX_FILE_BYTES) {
        failure = `${relPath} is ${size} bytes; the import per-file cap is ${SKILL_IMPORT_MAX_FILE_BYTES}.`;
        return;
      }
      totalBytes += size;
      if (totalBytes > SKILL_IMPORT_MAX_TOTAL_BYTES) {
        failure = `Skill exceeds ${SKILL_IMPORT_MAX_TOTAL_BYTES} bytes; that is the import bundle cap.`;
        return;
      }
    }
  };
  try {
    walk(dir);
  } catch (err) {
    return `Skill bundle could not be measured: ${err instanceof Error ? err.message : String(err)}`;
  }
  return failure;
}

export function parseSkillDir(dir: string): AcquiredSkill | null {
  const skillMdPath = join(dir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  const skillMd = readFileSync(skillMdPath, 'utf-8');

  const { name, description } = readSkillManifestMeta(skillMd, basename(dir));

  const files = readBundleFiles(dir);

  const hash = createHash('sha256');
  hash.update(`SKILL.md\n${skillMd}\n`);
  for (const f of files) {
    hash.update(`${f.relPath}\n`);
    hash.update(f.bytes ?? f.content ?? '');
    hash.update('\n');
  }

  return { name, description, skillMd, files, contentHash: hash.digest('hex') };
}

export function discoverSkillDirs(root: string): Array<{ name: string; dir: string }> {
  if (existsSync(join(root, 'SKILL.md'))) return [{ name: basename(root), dir: root }];
  const found: Array<{ name: string; dir: string }> = [];
  const MAX_DEPTH = 8;
  const MAX_DIRS = 5_000;
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || ++visited > MAX_DIRS) return;
    if (existsSync(join(dir, 'SKILL.md'))) {
      found.push({ name: basename(dir), dir });
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !DISCOVER_WALK_IGNORE.has(e.name)) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
