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

export const SCHEME_EXTENSIONS = ['.yaml', '.yml'] as const;

export const SAVED_THEME_SCAN_CAP = 500;

export const SAVED_THEME_DIRECTORY_ENTRY_CAP = 2_000;

export const SAVED_THEME_FILE_BYTE_LIMIT = 64 * 1024;

interface SavedThemeOk {
  ok: true;
  id: string;
  filename: string;
  scheme: Base16Scheme;
}

type SavedThemeWarningCode =
  | Base16ParseError['kind']
  | SavedThemeIdError
  | 'unsupported-extension-case'
  | 'duplicate-identity'
  | 'symlink'
  | 'not-regular-file'
  | 'file-too-large'
  | 'read-failed';

interface SavedThemeWarning {
  ok: false;
  filename: string;
  id?: string;
  code: SavedThemeWarningCode;
  conflictingFilenames?: string[];
}

export type SavedThemeEntry = SavedThemeOk | SavedThemeWarning;

export interface SavedThemeScanResult {
  entries: SavedThemeEntry[];
  truncated: boolean;
}

export interface ScanSavedThemesOptions {
  root?: string;
  homedirOverride?: string;
  cap?: number;
  observationCap?: number;
}

export function savedThemesDir(homedirOverride?: string): string {
  return resolve(homedirOverride ?? homedir(), OK_DIR, SAVED_THEMES_DIRNAME);
}

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
      } catch {}
    }
  } catch (err) {
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
    } catch {}
  }

  recordSavedThemeParseAttempt();
  const parsed = parseBase16Scheme(raw);
  if (!parsed.ok) {
    recordSavedThemeParseFailure();
    return { ok: false, filename, id: derived.id, code: parsed.error.kind };
  }
  return { ok: true, id: derived.id, filename, scheme: parsed.scheme };
}
