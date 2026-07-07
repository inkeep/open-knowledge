/**
 * One-time userData relocation for the "Open Knowledge" → "OpenKnowledge"
 * product rename.
 *
 * The desktop app stores app-level state (`state.json`: recent projects, window
 * restore, auto-update gates, …) under Electron's default userData dir, which
 * is derived from the packaged `productName` / CFBundleName:
 *   ~/Library/Application Support/<productName>/
 * When `productName` flips from "Open Knowledge" to "OpenKnowledge", that path
 * changes and orphans every existing user's state (and makes first-run
 * detection re-fire). This shim carries the legacy dir forward exactly once.
 *
 * Keyed on filesystem state, not version numbers: the only signal it needs is
 * "the running build's userData basename is the new name AND a legacy dir
 * exists AND it is verifiably ours AND we have not migrated yet." That handles
 * users who skip many releases and is a no-op for fresh installs.
 *
 * Safety — other vendors may ship an app literally named "Open Knowledge", so
 * `~/Library/Application Support/Open Knowledge/` is a generic path we do not
 * own by name alone:
 *   - Identity gate: the legacy dir is adopted ONLY if its `state.json` parses
 *     as our `AppState` shape (reuses `parseAppState`). A foreign or junk dir
 *     is left untouched.
 *   - Ordering: copy → verify → delete. The legacy dir is removed ONLY after a
 *     verified-good copy, so an interruption can never lose data — worst case
 *     is an orphaned legacy dir that the next launch skips.
 *   - Non-fatal: any failure degrades to first-run; never blocks app start.
 *
 * Accepted trade-off: after cleanup, downgrading to a pre-rename build sees a
 * fresh first-run (the data is safe under the new dir, but the old build reads
 * the old path). The rename is forward-only, so this is acceptable.
 *
 * Retireable: once the legacy tail is exhausted, this whole module can be
 * deleted.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseAppState } from './state-store.ts';

/** userData dir basename for pre-rename builds (CFBundleName "Open Knowledge"). */
const LEGACY_DIR_NAME = 'Open Knowledge';
/** userData dir basename for post-rename builds (CFBundleName "OpenKnowledge"). */
const TARGET_DIR_NAME = 'OpenKnowledge';
const STATE_FILE = 'state.json';

type UserDataMigrationStatus =
  | 'skipped-non-darwin'
  | 'skipped-not-target-name'
  | 'skipped-already-initialized'
  | 'skipped-no-legacy-dir'
  | 'skipped-unrecognized-legacy'
  | 'migrated'
  | 'failed';

export interface UserDataMigrationResult {
  status: UserDataMigrationStatus;
  legacyDir?: string;
  targetDir?: string;
  error?: string;
}

interface MigrationLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
}

const DEFAULT_LOGGER: MigrationLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
};

export interface MigrateLegacyUserDataOptions {
  /** The running build's userData dir, i.e. `app.getPath('userData')`. */
  userDataDir: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  logger?: MigrationLogger;
}

/**
 * A dir is "ours" iff it holds a `state.json` that parses as our `AppState`.
 * This is the foreign-app safety gate: `parseAppState` returns null for any
 * blob that is not our shape, so a different vendor's same-named dir is never
 * adopted.
 */
function dirHasOurState(stateFilePath: string): boolean {
  if (!existsSync(stateFilePath)) return false;
  // `readFileSync` is intentionally OUTSIDE the try: an OS-level error (EACCES,
  // EISDIR, …) propagates to the caller's try/catch so it surfaces as 'failed'
  // with the real cause, instead of being misreported as a foreign/unrecognized
  // directory. Only malformed JSON or a wrong shape — the genuine "not ours"
  // signal — returns false.
  const raw = readFileSync(stateFilePath, 'utf8');
  try {
    return parseAppState(JSON.parse(raw) as unknown) !== null;
  } catch {
    return false;
  }
}

export async function migrateLegacyUserDataDir(
  opts: MigrateLegacyUserDataOptions,
): Promise<UserDataMigrationResult> {
  const { userDataDir, platform } = opts;
  const logger = opts.logger ?? DEFAULT_LOGGER;

  // Desktop is macOS-only today; the legacy/target dir names are the macOS
  // Application Support basenames. Guard so a future Windows port wires its own
  // %APPDATA% migration rather than this one mis-firing on a foreign layout.
  if (platform !== 'darwin') {
    return { status: 'skipped-non-darwin' };
  }

  // Dormant until the packaged `productName` actually flips the userData
  // basename to the new name. Before the flip this is a no-op, so the shim is
  // safe to ship ahead of the rename.
  if (basename(userDataDir) !== TARGET_DIR_NAME) {
    return { status: 'skipped-not-target-name' };
  }

  const targetDir = userDataDir;
  const legacyDir = join(dirname(userDataDir), LEGACY_DIR_NAME);

  // One-time guard keyed on `state.json`, NOT dir existence: the target dir can
  // already exist on a pre-rename build because `path-install.ts` writes
  // `OpenKnowledge/path-install.json` independent of `productName`. Only a
  // present `state.json` means a post-rename build already initialized here.
  if (existsSync(join(targetDir, STATE_FILE))) {
    return { status: 'skipped-already-initialized', targetDir };
  }

  if (!existsSync(legacyDir)) {
    return { status: 'skipped-no-legacy-dir', targetDir };
  }

  try {
    // Foreign-app safety gate. A malformed/foreign state.json returns false
    // (→ skipped-unrecognized-legacy); an OS-level read error throws and is
    // reported as 'failed' by the catch below, never silently misclassified.
    if (!dirHasOurState(join(legacyDir, STATE_FILE))) {
      logger.event({ event: 'userdata-migration-unrecognized-legacy', legacyDir });
      return { status: 'skipped-unrecognized-legacy', legacyDir, targetDir };
    }

    mkdirSync(targetDir, { recursive: true });
    // Async recursive copy so a large legacy dir (accumulated Chromium cache)
    // never blocks the main process at startup. force:false + errorOnExist:false
    // → copy everything but never overwrite a file already present in the target
    // (e.g. the pre-existing `path-install.json`); skip those silently.
    await cp(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: false });

    // Verify the crown-jewel landed and is readable BEFORE any destructive step.
    if (!dirHasOurState(join(targetDir, STATE_FILE))) {
      logger.event({ event: 'userdata-migration-verify-failed', legacyDir, targetDir });
      return { status: 'failed', legacyDir, targetDir, error: 'post-copy verification failed' };
    }

    // Copy verified — safe to remove the legacy dir. A cleanup failure is
    // non-fatal: the data is already in the new dir and the next launch skips
    // via the `state.json` guard, leaving at most an orphaned legacy dir.
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch (err) {
      logger.event({
        event: 'userdata-migration-cleanup-failed',
        legacyDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.event({ event: 'userdata-migration-succeeded', legacyDir, targetDir });
    return { status: 'migrated', legacyDir, targetDir };
  } catch (err) {
    logger.event({
      event: 'userdata-migration-failed',
      legacyDir,
      targetDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'failed',
      legacyDir,
      targetDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
