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

const SAVE_EXTENSION = '.yaml';

interface SavedThemeWriteOptions {
  root?: string;
  homedirOverride?: string;
  lockTimeoutMs?: number;
}

type SavedThemeLockTimeoutResult = { ok: false; code: 'lock-timeout' };

async function withSavedThemeWriteLock<T>(
  root: string,
  home: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T | SavedThemeLockTimeoutResult> {
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
    } catch {}
  }
}

export type SavedThemeSaveResult =
  | { ok: true; id: string; filename: string }
  | { ok: false; code: 'name-taken' | SavedThemeIdError }
  | SavedThemeLockTimeoutResult;

export async function saveSavedTheme(
  params: {
    name: string;
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
      const claims = findClaimingFilenames(root, derived.stem);
      if (!claims.complete || claims.filenames.length > 0) return { ok: false, code: 'name-taken' };

      const filename = `${derived.stem}${params.extension ?? SAVE_EXTENSION}`;
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
  | { ok: false; code: 'ambiguous-id' | 'invalid-id' | 'unusable-theme' }
  | SavedThemeLockTimeoutResult;

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
