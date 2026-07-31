/**
 * Carry `/skill-name` references across a skill rename.
 *
 * A document rename rewrites its inbound links: the spine queries the backlink
 * index for every doc pointing at the target and mutates those bodies on disk.
 * A skill rename used to do none of that, and the asymmetry was invisible
 * rather than merely inconsistent — skill refs are resolved by NAME at read
 * time, so a renamed skill's inbound edges just stopped existing. The
 * referencing body still said `/oldname`, nothing answered to it, and
 * dead-link detection never noticed (computed edges never enter the backward
 * map, which is what `getDeadLinks` walks). Worse, a later skill claiming the
 * freed name silently inherited every stale ref.
 *
 * The sweep is a disk pass rather than an index query on purpose: global skills
 * are not content docs, so half the corpus is invisible to the link index, and
 * the population is tens of bundles.
 */
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

/** One rewritten markdown file, for the caller to re-index. */
export interface SkillRefRewrite {
  /** Base-relative bundle dir, e.g. `.claude/skills/grilling`. */
  readonly dir: string;
  /** Bundle-relative file: `SKILL.md`, or `references/<path>.md`. */
  readonly rel: string;
  readonly absPath: string;
  readonly markdown: string;
}

/** Markdown files in a bundle that can carry refs: SKILL.md + references/**.md. */
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

/**
 * Rewrite `/fromName` → `/toName` in every same-scope skill bundle under `base`.
 *
 * Same-scope only, matching how the refs resolve: a project ref never binds to a
 * global bundle. Unreadable or unwritable files are skipped and logged rather
 * than thrown — the rename itself already succeeded on disk, and failing the
 * request here would leave the user with a half-applied move.
 */
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
