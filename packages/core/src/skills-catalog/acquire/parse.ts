/**
 * Parse a fetched skill directory into an `AcquiredSkill` — name/description
 * (frontmatter, dir-name fallback), the full SKILL.md text, every bundle file's
 * CONTENTS (slice-1's reader returns paths only; import needs the bytes to
 * re-write them), and a stable sha256 `contentHash` (integrity + dedupe key).
 *
 * FULL-DIRECTORY fidelity: every file beside `SKILL.md` is captured (not only
 * `scripts/` + `references/` — root files, `assets/`, `.claude-plugin/`, any
 * subdir), so an import re-writes the skill byte-for-byte. Text files carry
 * UTF-8 `content`; binary files (NUL present) carry raw `bytes` instead, so
 * images/archives survive import without base64 bloat. `.git`/`node_modules`
 * are excluded as VCS/dependency noise. Scripts are content here, never
 * executed — the server trust gate is the enforcement point.
 */

import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  SKILL_IMPORT_MAX_BUNDLE_FILES,
  SKILL_IMPORT_MAX_FILE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_BYTES,
} from '../import-limits.ts';
import { readSkillManifestMeta } from '../manifest-meta.ts';

/** Directories never captured into a skill bundle (VCS + dependency noise). */
const BUNDLE_WALK_IGNORE: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Discovery skips the VCS/dependency noise above PLUS a skill's own bundle
 *  subdirs — descent stops at a skill dir, so these can only be its contents. */
const DISCOVER_WALK_IGNORE: ReadonlySet<string> = new Set([
  ...BUNDLE_WALK_IGNORE,
  'scripts',
  'references',
]);

export interface AcquiredFile {
  /** Skill-relative POSIX path, e.g. `scripts/run.sh`, `references/api.md`, `assets/logo.png`. */
  readonly relPath: string;
  /** UTF-8 text, or `null` when the file is binary — its raw bytes are in `bytes`. */
  readonly content: string | null;
  /** Raw bytes for a binary file (NUL present / non-UTF8); absent for text files. */
  readonly bytes?: Uint8Array;
}

export interface AcquiredSkill {
  readonly name: string;
  readonly description: string;
  /** Full SKILL.md text (frontmatter + body), verbatim. */
  readonly skillMd: string;
  readonly files: AcquiredFile[];
  /** sha256 over the canonical (path-sorted) bundle — integrity + dedupe. */
  readonly contentHash: string;
}

/**
 * Every file beside `SKILL.md` under `dir` (recursive), as skill-relative
 * entries. Text files carry UTF-8 `content`; binary files (any NUL byte) carry
 * raw `bytes`. `.git`/`node_modules` are skipped. Sorted by path.
 */
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
      // NUL byte ⇒ binary (mirrors the server's readSkillBundledFiles heuristic).
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

/**
 * Name + description only, reading `SKILL.md` and nothing else.
 *
 * For LISTING a fetched tree — the discover response, the preview's name-match
 * probe — where `parseSkillDir` would pull every byte of every bundle in the
 * repo (plus hash them) to render one line each. Use it whenever the contents
 * are not about to be written somewhere.
 */
export function readSkillDirMeta(dir: string): { name: string; description: string } | null {
  const skillMdPath = join(dir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  return readSkillManifestMeta(readFileSync(skillMdPath, 'utf-8'), basename(dir));
}

/**
 * Stat-only pre-flight for a FETCHED (untrusted) bundle: the same caps the
 * import applies, measured before anything is read. Returns the failure
 * message, or null when the tree fits.
 *
 * The downstream limit check runs on an already-materialized file array, so a
 * cloned repo holding a few 500 MB blobs exhausts the heap before that check
 * can fire. `statSync` costs nothing and the walk stops at the first breach.
 * Call this on every acquisition path (import, reimport, preview); local
 * already-on-disk skills stay unbounded, which is what their hash-compare
 * callers expect.
 */
export function acquiredBundleTooLarge(dir: string): string | null {
  let files = 0;
  let totalBytes = 0;
  let failure: string | null = null;
  // Every fs call here can fail on something other than size: EACCES/EPERM on an
  // unreadable dir, ENOENT if the tree changes under the walk. Callers treat the
  // return as "the reason to refuse, or null" and are entitled to that being the
  // ONLY outcome — a throw from a pre-flight size check would surface as an
  // internal error, and in a bulk import it would take the whole selection down.
  // An unreadable bundle is a refusal like any other.
  const refuse = (op: string, err: unknown): null => {
    failure = `Skill bundle could not be read (${op}): ${err instanceof Error ? err.message : String(err)}`;
    return null;
  };
  try {
    totalBytes = existsSync(join(dir, 'SKILL.md')) ? statSync(join(dir, 'SKILL.md')).size : 0;
  } catch (err) {
    return refuse('stat SKILL.md', err) ?? failure;
  }
  // Check SKILL.md against both caps HERE, not in the walk: the walk `continue`s
  // past SKILL.md, so a bundle whose only file is one enormous SKILL.md would
  // reach no check at all and read as "fits" — the cheapest possible version of
  // the heap exhaustion this pre-flight exists to prevent.
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
  // Defensive: the callers' contract is "the reason to refuse, or null", and a
  // throw from a pre-flight SIZE check would surface as an internal error — in a
  // bulk import, taking the whole selection down. The per-call guards above cover
  // the fs failures; this covers the rest (a pathologically deep tree exhausting
  // the recursion stack, most plausibly).
  try {
    walk(dir);
  } catch (err) {
    return `Skill bundle could not be measured: ${err instanceof Error ? err.message : String(err)}`;
  }
  return failure;
}

/**
 * Parse one skill directory (`<dir>/SKILL.md` + every other file). Returns
 * `null` when there is no SKILL.md. Malformed frontmatter degrades to the dir
 * name (never throws) so one bad source skill is degraded, not fatal.
 */
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

/**
 * Discover skill directories under a fetched root by walking the tree for any
 * `SKILL.md`. A root that is itself a skill-dir yields one entry named for the
 * dir; otherwise every directory containing a `SKILL.md` is a skill, at any
 * depth — repos shelve skills as `skills/<skill>/`, `skills/<category>/<skill>/`
 * (e.g. mattpocock/skills), `.claude/skills/<skill>/`, etc. Descent stops at a
 * skill dir (a skill's own `scripts/`/`references/` never nest another skill)
 * and skips VCS/dependency noise. Sorted by name.
 */
export function discoverSkillDirs(root: string): Array<{ name: string; dir: string }> {
  if (existsSync(join(root, 'SKILL.md'))) return [{ name: basename(root), dir: root }];
  const found: Array<{ name: string; dir: string }> = [];
  const MAX_DEPTH = 8;
  // Depth alone does not bound the work: `source` can be a local path, so a
  // root of `~` stat-walks an entire home directory on the main thread — which
  // is also the thread serving the collab websocket, so every open editor
  // freezes for the duration. Cap the directories visited too.
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
      // One unreadable directory (EACCES/EPERM, or a race that unlinks it
      // mid-walk) is not an enumeration failure — every OTHER skill in the
      // source is still discoverable, and a throw here would take down the
      // preview, the picker, and a whole bulk import along with it. The
      // unreadable dir simply contributes nothing.
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
