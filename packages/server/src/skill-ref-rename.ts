import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rewriteSkillRefs } from '@inkeep/open-knowledge-core';
import { tracedWriteFileSync } from './fs-traced.ts';
import {
  type InPlaceSkill,
  scanGlobalInPlaceSkills,
  scanInPlaceSkills,
} from './in-place-skills.ts';
import { getLogger } from './logger.ts';

export interface SkillRefRewrite {
  readonly dir: string;
  readonly rel: string;
  readonly absPath: string;
  readonly markdown: string;
}

function bundleMarkdownFiles(bundleDir: string): string[] {
  const out: string[] = [];
  if (existsSync(resolve(bundleDir, 'SKILL.md'))) out.push('SKILL.md');
  const refsDir = resolve(bundleDir, 'references');
  if (!existsSync(refsDir)) return out;
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(`references/${rel}`);
      }
    }
  };
  walk(refsDir, '');
  return out;
}

export function rewriteSkillRefsAcrossScope(opts: {
  base: string;
  scope: 'project' | 'global';
  fromName: string;
  toName: string;
}): SkillRefRewrite[] {
  const { base, scope, fromName, toName } = opts;
  if (fromName === toName) return [];
  const log = getLogger('skill-ref-rename');

  let skills: InPlaceSkill[];
  try {
    skills = scope === 'project' ? scanInPlaceSkills(base) : scanGlobalInPlaceSkills(base);
  } catch (err) {
    log.warn({ err, scope }, 'skill scan failed; refs to the old name are left as authored');
    return [];
  }

  const rewritten: SkillRefRewrite[] = [];
  for (const skill of skills) {
    const bundleDir = resolve(base, skill.dir);
    for (const rel of bundleMarkdownFiles(bundleDir)) {
      const absPath = resolve(bundleDir, rel);
      let before: string;
      try {
        before = readFileSync(absPath, 'utf-8');
      } catch (err) {
        log.warn({ err, absPath }, 'unreadable skill markdown; skipped');
        continue;
      }
      const after = rewriteSkillRefs(before, fromName, toName);
      if (after === before) continue;
      try {
        tracedWriteFileSync(absPath, after, 'utf-8');
      } catch (err) {
        log.warn({ err, absPath }, 'skill ref rewrite could not be written; skipped');
        continue;
      }
      rewritten.push({ dir: skill.dir, rel, absPath, markdown: after });
    }
  }
  return rewritten;
}
