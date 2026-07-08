/**
 * Per-skill restore — net-new, fs-direct.
 *
 * lands the folder timeline/history substrate but NOT `.ok/`-artifact
 * restore (the existing `restore_version` is a CRDT paired-write that
 * reconstructs from in-memory Y.Doc bytes; skills have no Y.Doc). So restoring a
 * skill version is fresh code on top of the shadow repo: read the skill's source
 * tree at a commit SHA out of the shadow object store and rewrite it into the
 * content dir. Version SHAs come from `getDocumentHistory` (the unified doc/skill timeline).
 *
 * Text-tree restore (SKILL.md + references/ + text scripts) via `git show`.
 * Binary assets inside a skill are out of scope for v1 (rare; the dominant
 * shape is markdown). The restore is authoritative — the current skill dir is
 * cleared first so files added after `version` don't linger.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import { type ShadowHandle, shadowGit } from './shadow-repo.ts';

/** Shadow-repo path of a project-scope skill's source dir for a content root. */
function skillShadowPath(contentRoot: string, name: string): string {
  const root = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  return root ? `${root}/.ok/skills/${name}` : `.ok/skills/${name}`;
}

/**
 * Discriminated result. `code` lets the route map a genuine git/disk I/O
 * failure to 5xx instead of collapsing every non-ok outcome to 404:
 *   - `no-shadow` / `version-not-found` / `skill-absent` → client-visible 404/409
 *   - `io-error` (a `git show` failure) / `path-escape` → server-side 5xx
 */
export type RestoreSkillResult =
  | { ok: true; restoredFiles: string[] }
  | {
      ok: false;
      code: 'no-shadow' | 'version-not-found' | 'skill-absent' | 'io-error' | 'path-escape';
      error: string;
    };

/**
 * Does a git error message mean "this object/revision genuinely isn't here"
 * (→ client 404) rather than "git failed for an I/O reason" (→ server 5xx)?
 *
 * This boundary is load-bearing: it's the only thing keeping a corrupt-repo /
 * missing-binary failure from being masked as a stale-version 404 (callers stop
 * retrying, operators never see the fault). Exported + unit-tested so the
 * regex can't silently broaden to swallow genuine server faults. Single source —
 * the `ls-tree` catch calls this rather than inlining the pattern.
 */
export function isGitObjectNotFound(message: string): boolean {
  return /not a valid object name|not a tree object|bad revision|unknown revision|invalid object name/i.test(
    message,
  );
}

/**
 * Restore `.ok/skills/<name>/` to its state at shadow-repo commit `version`.
 * Reads the tree at that SHA and rewrites it into the content dir, clearing the
 * current dir first (authoritative). Returns the restored file list (skill-dir
 * relative) or a structured error.
 */
export async function restoreSkillVersion(opts: {
  shadow: ShadowHandle;
  contentDir: string;
  contentRoot: string;
  name: string;
  version: string;
}): Promise<RestoreSkillResult> {
  const { shadow, contentDir, contentRoot, name, version } = opts;
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) {
    return { ok: false, code: 'no-shadow', error: 'No shadow repo — nothing to restore from.' };
  }
  const shadowPath = skillShadowPath(contentRoot, name);
  const sg = shadowGit(shadow);

  let files: string[];
  try {
    files = await listNames(sg, ['ls-tree', '-r', '--name-only', version, '--', shadowPath]);
  } catch (e) {
    // Distinguish "this commit/SHA genuinely isn't in the shadow repo" (a client
    // 404) from a git I/O failure — git binary missing, repo corrupt, etc. (a
    // 5xx). A bad object/revision is the only not-found signal; everything else
    // is an io-error so the route doesn't mask a server fault as a stale-version
    // 404.
    const msg = e instanceof Error ? e.message : String(e);
    return isGitObjectNotFound(msg)
      ? { ok: false, code: 'version-not-found', error: `Version ${version.slice(0, 8)} not found.` }
      : {
          ok: false,
          code: 'io-error',
          error: `Failed to read version ${version.slice(0, 8)}: ${msg}`,
        };
  }
  if (files.length === 0) {
    return {
      ok: false,
      code: 'skill-absent',
      error: `Skill "${name}" did not exist at version ${version.slice(0, 8)}.`,
    };
  }

  // Read EVERY file's content from the shadow object store AND resolve its
  // destination BEFORE touching the on-disk skill. The restore clears the dir
  // authoritatively, so a `git show` failure or an escaping path mid-rewrite
  // would leave a torn skill. Read-all-and-validate-first means any failure
  // aborts before a single destructive write.
  const skillDirAbs = resolve(contentDir, '.ok', 'skills', name);
  const containmentPrefix = skillDirAbs + sep;
  const staged: Array<{ rel: string; destAbs: string; content: string }> = [];
  for (const shadowFile of files) {
    const rel = shadowFile.slice(shadowPath.length).replace(/^\//, '');
    const destAbs = resolve(skillDirAbs, rel);
    // A shadow tree entry that resolves outside the skill dir (e.g. via `..`)
    // must never be written — refuse before the destructive clear.
    if (destAbs !== skillDirAbs && !destAbs.startsWith(containmentPrefix)) {
      return {
        ok: false,
        code: 'path-escape',
        error: `Refusing to restore path outside skill dir: ${rel}`,
      };
    }
    try {
      staged.push({ rel, destAbs, content: await sg.raw('show', `${version}:${shadowFile}`) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        code: 'io-error',
        error: `Failed reading ${rel} at ${version.slice(0, 8)}: ${msg}`,
      };
    }
  }

  // All content read + paths validated — now it's safe to clear + rewrite.
  tracedRmSync(skillDirAbs, { recursive: true, force: true });
  const restoredFiles: string[] = [];
  for (const { rel, destAbs, content } of staged) {
    tracedMkdirSync(dirname(destAbs), { recursive: true });
    tracedWriteFileSync(destAbs, content, 'utf-8');
    restoredFiles.push(rel);
  }
  return { ok: true, restoredFiles };
}
