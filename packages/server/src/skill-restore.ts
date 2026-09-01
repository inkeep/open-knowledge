import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from './fs-traced.ts';
import { listNames } from './git-paths.ts';
import { type ShadowHandle, shadowGit } from './shadow-repo.ts';

function skillShadowPath(contentRoot: string, skillDirRel: string): string {
  const root = contentRoot === '.' ? '' : contentRoot.replace(/^\.\//, '');
  return root ? `${root}/${skillDirRel}` : skillDirRel;
}

export type RestoreSkillResult =
  | { ok: true; restoredFiles: string[] }
  | {
      ok: false;
      code: 'no-shadow' | 'version-not-found' | 'skill-absent' | 'io-error' | 'path-escape';
      error: string;
    };

export function isGitObjectNotFound(message: string): boolean {
  return /not a valid object name|not a tree object|bad revision|unknown revision|invalid object name/i.test(
    message,
  );
}

export async function restoreSkillVersion(opts: {
  shadow: ShadowHandle;
  contentDir: string;
  contentRoot: string;
  name: string;
  version: string;
  skillDirRel?: string;
}): Promise<RestoreSkillResult> {
  const { shadow, contentDir, contentRoot, name, version } = opts;
  const skillDirRel = opts.skillDirRel ?? `.ok/skills/${name}`;
  if (!existsSync(shadow.workTree) || !existsSync(shadow.gitDir)) {
    return { ok: false, code: 'no-shadow', error: 'No shadow repo — nothing to restore from.' };
  }
  const sg = shadowGit(shadow);

  const candidateRels = [...new Set([skillDirRel, `.ok/skills/${name}`])];
  let files: string[] = [];
  let shadowPath = skillShadowPath(contentRoot, skillDirRel);
  try {
    for (const rel of candidateRels) {
      const candidatePath = skillShadowPath(contentRoot, rel);
      const found = await listNames(sg, [
        'ls-tree',
        '-r',
        '--name-only',
        version,
        '--',
        candidatePath,
      ]);
      if (found.length > 0) {
        files = found;
        shadowPath = candidatePath;
        break;
      }
    }
  } catch (e) {
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

  const skillDirAbs = resolve(contentDir, skillDirRel);
  const containmentPrefix = skillDirAbs + sep;
  const staged: Array<{ rel: string; destAbs: string; content: string }> = [];
  for (const shadowFile of files) {
    const rel = shadowFile.slice(shadowPath.length).replace(/^\//, '');
    const destAbs = resolve(skillDirAbs, rel);
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

  tracedRmSync(skillDirAbs, { recursive: true, force: true });
  const restoredFiles: string[] = [];
  for (const { rel, destAbs, content } of staged) {
    tracedMkdirSync(dirname(destAbs), { recursive: true });
    tracedWriteFileSync(destAbs, content, 'utf-8');
    restoredFiles.push(rel);
  }
  return { ok: true, restoredFiles };
}
