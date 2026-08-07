/**
 * The saved-theme store's write path — the strict, coded half of the store's
 * two-bar split (`saved-themes-store.ts` is the permissive total read).
 *
 * Save refuses a name that can't become a palette id, and refuses one already
 * taken by a file in the store, before writing anything — a name collision never
 * overwrites prior work. Delete removes the one scheme file outright and retains
 * no copy anywhere (no backup dir, no trash): the reversibility a user gets is
 * the UI's time-boxed undo, not a file OK keeps behind their back.
 *
 * All operations write through the traced-fs wrappers so every disk mutation
 * lands an `fs.*` span; the store folder is created lazily on the first save
 * (the read path never creates it).
 */

import { createHash } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Base16Scheme,
  base16ToYaml,
  deriveSavedThemeId,
  deriveSavedThemeName,
  OK_DIR,
  parseSavedThemeId,
  type SavedThemeIdError,
} from '@inkeep/open-knowledge-core';
import {
  atomicWriteFile,
  FileLockTimeoutError,
  withFileLock,
} from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir, tracedUnlinkSync } from './fs-traced.ts';
import {
  readSavedThemeFile,
  SAVED_THEME_DIRECTORY_ENTRY_CAP,
  SCHEME_EXTENSIONS,
  savedThemesDir,
} from './saved-themes-store.ts';
import { recordSavedThemeDelete, recordSavedThemeSave } from './saved-themes-telemetry.ts';

/** The canonical extension the save path writes. A theme is saved as `.yaml`
 *  even if a hand-dropped sibling used `.yml`; both are recognized on read and
 *  on collision/delete resolution. */
const SAVE_EXTENSION = '.yaml';

/** Locate the store root once for an operation: an explicit `root` wins,
 *  otherwise resolve it under the (possibly overridden) home directory. */
interface SavedThemeWriteOptions {
  /** Absolute path to the store folder, used verbatim when given. */
  root?: string;
  /** Test seam: resolve the store under this home instead of `os.homedir()`. */
  homedirOverride?: string;
  /** Maximum time to wait for another process writing the same store. */
  lockTimeoutMs?: number;
}

/** Retryable refusal when another process holds the user-global store mutex. */
type SavedThemeLockTimeoutResult = { ok: false; code: 'lock-timeout' };

async function withSavedThemeWriteLock<T>(
  root: string,
  home: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T | SavedThemeLockTimeoutResult> {
  // The user-owned store remains scheme-files-only. Keep its hashed mutex in the
  // user-owned OK directory so another OS user cannot preclaim the predictable
  // name in a shared temp directory and wedge every saved-theme writer.
  const lockDir = resolve(home, OK_DIR);
  await tracedMkdir(lockDir, { recursive: true });
  const rootKey = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24);
  try {
    return await withFileLock(join(lockDir, `saved-themes-${rootKey}.lock`), fn, {
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) return { ok: false, code: 'lock-timeout' };
    throw error;
  }
}

function targetState(path: string): 'missing' | 'regular' | 'unsafe' {
  try {
    return lstatSync(path).isFile() ? 'regular' : 'unsafe';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * Find every directory entry that claims a stem under a supported extension,
 * including extension-case variants. Stem matching stays exact so a malformed
 * uppercase stem can never be reached through a valid lowercase id. Only the
 * extension is case-folded because its portable filename identity is reserved.
 * An overlarge directory fails closed rather than risking a hidden collision.
 */
function findClaimingFilenames(
  root: string,
  stem: string,
): { complete: boolean; filenames: string[] } {
  const filenames: string[] = [];
  let dir: ReturnType<typeof opendirSync>;
  try {
    dir = opendirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { complete: true, filenames };
    throw err;
  }

  try {
    for (let observed = 0; observed < SAVED_THEME_DIRECTORY_ENTRY_CAP; observed += 1) {
      const entry = dir.readSync();
      if (entry === null) return { complete: true, filenames: filenames.sort() };
      const lowerName = entry.name.toLowerCase();
      const extension = SCHEME_EXTENSIONS.find((candidate) => lowerName.endsWith(candidate));
      if (extension && entry.name.slice(0, -extension.length) === stem) {
        filenames.push(entry.name);
      }
    }
    return { complete: dir.readSync() === null, filenames: filenames.sort() };
  } finally {
    try {
      dir.closeSync();
    } catch {
      // Reading through end-of-directory may auto-close the handle.
    }
  }
}

export type SavedThemeSaveResult =
  | { ok: true; id: string; filename: string }
  /** `name-taken`: the stem already names a file in the store. Otherwise one of
   *  the id-grammar failures (`empty` / `too-long` / `invalid-chars`). */
  | { ok: false; code: 'name-taken' | SavedThemeIdError }
  | SavedThemeLockTimeoutResult;

/**
 * Save a palette under `name` as a scheme file in the store. `name` is the
 * theme's identity — its filename stem and, namespaced, its palette id — so it
 * must fit the id grammar; a name that doesn't, or one already taken, is refused
 * with a distinguishing code and nothing is written. On success the file is
 * written atomically (tmp + rename) so a concurrent scan never sees a half-file.
 */
export async function saveSavedTheme(
  params: {
    name: string;
    /** Exact filename stem for restoring a deleted file. New saves derive it from `name`. */
    stem?: string;
    scheme: Base16Scheme;
    extension?: (typeof SCHEME_EXTENSIONS)[number];
  } & SavedThemeWriteOptions,
): Promise<SavedThemeSaveResult> {
  const identity =
    params.stem !== undefined
      ? (() => {
          const derived = deriveSavedThemeId(params.stem);
          return derived.ok ? { ...derived, stem: params.stem } : derived;
        })()
      : deriveSavedThemeName(params.name);
  const derived = identity;
  if (!derived.ok) return { ok: false, code: derived.code };

  const home = params.homedirOverride ?? homedir();
  const root = params.root ?? savedThemesDir(home);
  return withSavedThemeWriteLock(
    root,
    home,
    async () => {
      // Collision is by filename identity: a stem already present under EITHER
      // recognized extension maps to the same id, so writing would shadow it.
      const claims = findClaimingFilenames(root, derived.stem);
      if (!claims.complete || claims.filenames.length > 0) return { ok: false, code: 'name-taken' };

      const filename = `${derived.stem}${params.extension ?? SAVE_EXTENSION}`;
      // On a case-insensitive filesystem an invalid `Ocean.yaml` aliases the
      // canonical `ocean.yaml` path even though its stem is not a valid claimant.
      // Refuse that filesystem-level collision instead of overwriting the file.
      if (targetState(join(root, filename)) !== 'missing') {
        return { ok: false, code: 'name-taken' };
      }
      await tracedMkdir(root, { recursive: true });
      await atomicWriteFile(join(root, filename), base16ToYaml(params.scheme), {
        fs: tracedAtomicFs,
        sweepStaleTmps: false,
      });
      recordSavedThemeSave();
      return { ok: true, id: derived.id, filename };
    },
    params.lockTimeoutMs,
  );
}

export type SavedThemeUpdateResult =
  | { ok: true; id: string; filename: string }
  | { ok: false; code: 'ambiguous-id' | 'invalid-id' | 'not-found' | 'unsafe-target' }
  | SavedThemeLockTimeoutResult;

/**
 * Replace the scheme file an existing saved-theme id names. The same filename
 * and extension are retained, so this is a true in-place update; a missing id
 * is refused instead of becoming an accidental create/upsert.
 */
export async function updateSavedTheme(
  params: { id: string; scheme: Base16Scheme } & SavedThemeWriteOptions,
): Promise<SavedThemeUpdateResult> {
  const parsed = parseSavedThemeId(params.id);
  if (!parsed.ok) return { ok: false, code: 'invalid-id' };

  const home = params.homedirOverride ?? homedir();
  const root = params.root ?? savedThemesDir(home);
  return withSavedThemeWriteLock(
    root,
    home,
    async () => {
      const claims = findClaimingFilenames(root, parsed.stem);
      if (!claims.complete) return { ok: false, code: 'ambiguous-id' };
      const { filenames } = claims;
      if (filenames.length === 0) return { ok: false, code: 'not-found' };
      if (filenames.length > 1) return { ok: false, code: 'ambiguous-id' };

      const filename = filenames[0];
      if (!filename) return { ok: false, code: 'not-found' };
      if (!SCHEME_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
        return { ok: false, code: 'unsafe-target' };
      }
      if (targetState(join(root, filename)) !== 'regular') {
        return { ok: false, code: 'unsafe-target' };
      }
      await atomicWriteFile(join(root, filename), base16ToYaml(params.scheme), {
        fs: tracedAtomicFs,
        sweepStaleTmps: false,
      });
      return { ok: true, id: params.id, filename };
    },
    params.lockTimeoutMs,
  );
}

export type SavedThemeDeleteResult =
  | { ok: true; existed: false }
  | { ok: true; existed: true; filename: string; scheme: Base16Scheme }
  /** The id is not a well-formed saved-theme id (a client-shape bug). */
  | { ok: false; code: 'ambiguous-id' | 'invalid-id' | 'unusable-theme' }
  | SavedThemeLockTimeoutResult;

/**
 * Delete the scheme file a saved-theme id names. Idempotent: an id that names no
 * file is `{ existed: false }`, not an error. The stem recovered from the id is
 * `[a-z0-9-]+` by construction (that is what `parseSavedThemeId` guarantees), so
 * it can't traverse out of the store — no path-containment guard is needed. No
 * copy of the file is written anywhere before it is removed.
 */
export async function deleteSavedTheme(
  params: { id: string } & SavedThemeWriteOptions,
): Promise<SavedThemeDeleteResult> {
  const parsed = parseSavedThemeId(params.id);
  if (!parsed.ok) return { ok: false, code: 'invalid-id' };

  const home = params.homedirOverride ?? homedir();
  const root = params.root ?? savedThemesDir(home);
  return withSavedThemeWriteLock(
    root,
    home,
    async () => {
      const claims = findClaimingFilenames(root, parsed.stem);
      if (!claims.complete) return { ok: false, code: 'ambiguous-id' };
      const { filenames } = claims;
      if (filenames.length === 0) return { ok: true, existed: false };
      if (filenames.length > 1) return { ok: false, code: 'ambiguous-id' };

      const filename = filenames[0];
      if (!filename) return { ok: true, existed: false };
      const entry = readSavedThemeFile(root, filename);
      if (entry === null) return { ok: true, existed: false };
      if (!entry.ok) return { ok: false, code: 'unusable-theme' };

      tracedUnlinkSync(join(root, filename));
      recordSavedThemeDelete();
      return { ok: true, existed: true, filename, scheme: entry.scheme };
    },
    params.lockTimeoutMs,
  );
}
