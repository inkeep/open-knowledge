/**
 * The user-global saved-theme store: a folder of Tinted Theming scheme files
 * under `<homedir>/.ok/themes/`, one file per theme, filename stem as identity.
 *
 * This module is the store's read path — a total, bounded enumeration. It is the
 * permissive half of the store's two-bar split: it never throws and still lists a
 * broken entry (a file that fails to parse, or whose name can't become a valid
 * id) as a warning rather than dropping it, so a theme a user placed can always
 * be seen and fixed. The strict, coded write validator is a separate surface.
 *
 * Discovery is by scan, re-run at boot and when the theme settings surface opens.
 * There is deliberately no live filesystem watcher here.
 *
 * Nothing proprietary is persisted: the scheme files are the only artifacts, so
 * this reader neither writes nor lazily creates anything — a missing folder stays
 * missing and simply reads as empty.
 */

import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  type Base16ParseError,
  type Base16Scheme,
  deriveSavedThemeId,
  OK_DIR,
  parseBase16Scheme,
  SAVED_THEMES_DIRNAME,
  type SavedThemeIdError,
} from '@inkeep/open-knowledge-core';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import {
  recordSavedThemeParseAttempt,
  recordSavedThemeParseFailure,
  recordSavedThemeScan,
  recordSavedThemeUsableCount,
} from './saved-themes-telemetry.ts';

const log = getLogger('saved-themes');

/** Scheme-file extensions the store recognizes. The Tinted Theming ecosystem and
 *  OK's own serializer both emit YAML; other extensions are not theme files.
 *  Exported so the write path checks collisions and resolves deletes against the
 *  same set the scan lists — one source, no drift. */
export const SCHEME_EXTENSIONS = ['.yaml', '.yml'] as const;

/**
 * Upper bound on entries a single scan lists. The scan runs on the collaboration
 * thread, so it caps rather than enumerating an unbounded folder; a scan that
 * hits the cap reports `truncated` instead of silently cutting the list. Matches
 * the order of magnitude of the sibling artifact-list caps.
 */
export const SAVED_THEME_SCAN_CAP = 500;

/** Maximum directory entries observed during one scan, including non-themes. */
export const SAVED_THEME_DIRECTORY_ENTRY_CAP = 2_000;

/** Maximum bytes read from one user-owned scheme file. */
export const SAVED_THEME_FILE_BYTE_LIMIT = 64 * 1024;

/** A usable saved theme: a parsed scheme carrying a valid namespaced id. A member
 *  of the exported `SavedThemeEntry` union; callers narrow via `entry.ok`. */
interface SavedThemeOk {
  ok: true;
  /** Namespaced palette id (`SAVED_THEME_ID_PREFIX` + filename stem). */
  id: string;
  /** Filename including extension — the stable delete/edit target. */
  filename: string;
  /** The parsed Tinted Theming scheme (standard fields only). */
  scheme: Base16Scheme;
}

/**
 * Why a folder entry could not become a usable theme. The parse causes come
 * from the base16 parser; the id causes from filename-stem derivation. Derived
 * from the source taxonomies so a new parser or id failure mode surfaces here
 * without a manual edit.
 */
type SavedThemeWarningCode =
  | Base16ParseError['kind']
  | SavedThemeIdError
  | 'unsupported-extension-case'
  | 'duplicate-identity'
  | 'symlink'
  | 'not-regular-file'
  | 'file-too-large'
  | 'read-failed';

/** A listed-but-unusable entry: it exists, carries a reason, and can be fixed. A
 *  member of the exported `SavedThemeEntry` union; callers narrow via `entry.ok`. */
interface SavedThemeWarning {
  ok: false;
  /** Filename including extension — shown so the user knows the file is there. */
  filename: string;
  /** Present when the name yielded a valid id but the contents failed to parse. */
  id?: string;
  /** Machine-readable reason; the UI maps it to localized, human-readable copy. */
  code: SavedThemeWarningCode;
  /** All files claiming the same filename-stem identity. */
  conflictingFilenames?: string[];
}

export type SavedThemeEntry = SavedThemeOk | SavedThemeWarning;

export interface SavedThemeScanResult {
  entries: SavedThemeEntry[];
  /** True when the folder held more scheme files than the scan listed. */
  truncated: boolean;
}

export interface ScanSavedThemesOptions {
  /**
   * Absolute path to the store folder. When given, it is used verbatim and
   * `homedirOverride` is ignored — the caller has already resolved the root.
   */
  root?: string;
  /**
   * Test seam: resolve the store under this home directory instead of
   * `os.homedir()`. A parameter, never an environment variable, so parallel
   * tests stay isolated.
   */
  homedirOverride?: string;
  /** Scan bound; defaults to `SAVED_THEME_SCAN_CAP`. */
  cap?: number;
  /** Directory-entry observation bound; defaults to `SAVED_THEME_DIRECTORY_ENTRY_CAP`. */
  observationCap?: number;
}

/** Absolute path to the saved-theme store under a (possibly overridden) home. */
export function savedThemesDir(homedirOverride?: string): string {
  return resolve(homedirOverride ?? homedir(), OK_DIR, SAVED_THEMES_DIRNAME);
}

/**
 * Enumerate the saved-theme store: one entry per scheme identity, sorted by
 * name. When the directory-observation bound is reached, `truncated` is true;
 * membership then reflects the filesystem's bounded first page and is not
 * claimed to be stable across platforms.
 *
 * Per-entry isolated: one unreadable, unparseable, or badly-named file never
 * fails enumeration or hides its siblings. A missing folder is an empty result,
 * not an error.
 */
export function scanSavedThemes(options: ScanSavedThemesOptions = {}): SavedThemeScanResult {
  recordSavedThemeScan();
  const root = options.root ?? savedThemesDir(options.homedirOverride);
  const cap = options.cap ?? SAVED_THEME_SCAN_CAP;

  const dirents: Dirent[] = [];
  let observationTruncated = false;
  try {
    const dir = opendirSync(root);
    try {
      const observationCap = options.observationCap ?? SAVED_THEME_DIRECTORY_ENTRY_CAP;
      while (dirents.length < observationCap) {
        const entry = dir.readSync();
        if (entry === null) break;
        dirents.push(entry);
      }
      observationTruncated = dir.readSync() !== null;
    } finally {
      try {
        dir.closeSync();
      } catch {
        // Reading through end-of-directory may auto-close the handle.
      }
    }
  } catch (err) {
    // A missing store is the ordinary cold-start case: no themes yet. Any other
    // failure (EACCES, ENOTDIR) still degrades to "no saved themes" so the picker
    // keeps working, and earns a log so an operator can trace it.
    if (errnoCode(err) !== 'ENOENT') {
      log.warn(
        { root, reason: err instanceof Error ? err.message : String(err) },
        `failed to read saved-theme store at ${root} — treating as empty`,
      );
    } else {
      recordSavedThemeUsableCount(0);
    }
    return { entries: [], truncated: false };
  }

  const candidates = dirents
    .filter(isSchemeCandidate)
    .map((d) => d.name)
    .sort();

  const groups = new Map<string, string[]>();
  for (const filename of candidates) {
    const stem = schemeStem(filename);
    const group = groups.get(stem) ?? [];
    group.push(filename);
    groups.set(stem, group);
  }

  const identities = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const truncated = observationTruncated || identities.length > cap;
  if (truncated) {
    log.warn(
      { root, cap, found: identities.length, observationTruncated },
      `saved-theme store at ${root} exceeded a scan bound; the returned list is incomplete.`,
    );
  }

  const entries: SavedThemeEntry[] = [];
  for (const [stem, filenames] of identities.slice(0, cap)) {
    const filename = filenames[0];
    if (!filename) continue;
    if (filenames.length > 1) {
      const derived = deriveSavedThemeId(stem);
      entries.push({
        ok: false,
        filename,
        ...(derived.ok ? { id: derived.id } : {}),
        code: 'duplicate-identity',
        conflictingFilenames: filenames,
      });
      continue;
    }
    const entry = readSavedThemeFile(root, filename);
    if (entry) entries.push(entry);
  }
  recordSavedThemeUsableCount(entries.filter((entry) => entry.ok).length);
  return { entries, truncated };
}

/** A scheme candidate is a non-hidden regular file (or symlink to one) with a
 *  scheme extension. Dotfiles (`.DS_Store`, hidden schemes) and subdirectories
 *  are not themes. */
function isSchemeCandidate(entry: Dirent): boolean {
  if (entry.name.startsWith('.')) return false;
  const lower = entry.name.toLowerCase();
  return SCHEME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function schemeStem(filename: string): string {
  const lower = filename.toLowerCase();
  const extension = SCHEME_EXTENSIONS.find((ext) => lower.endsWith(ext));
  return extension ? filename.slice(0, -extension.length) : parse(filename).name;
}

/**
 * Read one candidate into an entry, or `null` when it should drop silently.
 * Derivation runs first: a name that can't be an id is unusable regardless of
 * contents, and listing it (without reading) already tells the user what to fix.
 */
export function readSavedThemeFile(root: string, filename: string): SavedThemeEntry | null {
  const derived = deriveSavedThemeId(parse(filename).name);
  if (!derived.ok) return { ok: false, filename, code: derived.code };
  if (!SCHEME_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    return { ok: false, filename, id: derived.id, code: 'unsupported-extension-case' };
  }

  const path = join(root, filename);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { ok: false, filename, id: derived.id, code: 'symlink' };
    }
    if (!stat.isFile()) {
      return { ok: false, filename, id: derived.id, code: 'not-regular-file' };
    }
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    log.warn(
      { root, filename, reason: err instanceof Error ? err.message : String(err) },
      `failed to inspect saved theme ${filename} — listed as unreadable`,
    );
    return { ok: false, filename, id: derived.id, code: 'read-failed' };
  }

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') return { ok: false, filename, id: derived.id, code: 'symlink' };
    log.warn(
      { root, filename, reason: err instanceof Error ? err.message : String(err) },
      `failed to open saved theme ${filename} — listed as unreadable`,
    );
    return { ok: false, filename, id: derived.id, code: 'read-failed' };
  }

  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, filename, id: derived.id, code: 'not-regular-file' };
    }
    if (stat.size > SAVED_THEME_FILE_BYTE_LIMIT) {
      return { ok: false, filename, id: derived.id, code: 'file-too-large' };
    }

    const buffer = Buffer.alloc(SAVED_THEME_FILE_BYTE_LIMIT + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > SAVED_THEME_FILE_BYTE_LIMIT) {
      return { ok: false, filename, id: derived.id, code: 'file-too-large' };
    }
    raw = buffer.subarray(0, bytesRead).toString('utf-8');
  } catch (err) {
    log.warn(
      { root, filename, reason: err instanceof Error ? err.message : String(err) },
      `failed to read saved theme ${filename} — listed as unreadable`,
    );
    return { ok: false, filename, id: derived.id, code: 'read-failed' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read result is already determined; close failure must not make the
      // total scanner throw and hide every other theme.
    }
  }

  recordSavedThemeParseAttempt();
  const parsed = parseBase16Scheme(raw);
  if (!parsed.ok) {
    recordSavedThemeParseFailure();
    return { ok: false, filename, id: derived.id, code: parsed.error.kind };
  }
  return { ok: true, id: derived.id, filename, scheme: parsed.scheme };
}
