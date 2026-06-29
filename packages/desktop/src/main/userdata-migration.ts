
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseAppState } from './state-store.ts';

const LEGACY_DIR_NAME = 'Open Knowledge';
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
  userDataDir: string;
  platform: NodeJS.Platform;
  logger?: MigrationLogger;
}

function dirHasOurState(stateFilePath: string): boolean {
  if (!existsSync(stateFilePath)) return false;
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

  if (platform !== 'darwin') {
    return { status: 'skipped-non-darwin' };
  }

  if (basename(userDataDir) !== TARGET_DIR_NAME) {
    return { status: 'skipped-not-target-name' };
  }

  const targetDir = userDataDir;
  const legacyDir = join(dirname(userDataDir), LEGACY_DIR_NAME);

  if (existsSync(join(targetDir, STATE_FILE))) {
    return { status: 'skipped-already-initialized', targetDir };
  }

  if (!existsSync(legacyDir)) {
    return { status: 'skipped-no-legacy-dir', targetDir };
  }

  try {
    if (!dirHasOurState(join(legacyDir, STATE_FILE))) {
      logger.event({ event: 'userdata-migration-unrecognized-legacy', legacyDir });
      return { status: 'skipped-unrecognized-legacy', legacyDir, targetDir };
    }

    mkdirSync(targetDir, { recursive: true });
    await cp(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: false });

    if (!dirHasOurState(join(targetDir, STATE_FILE))) {
      logger.event({ event: 'userdata-migration-verify-failed', legacyDir, targetDir });
      return { status: 'failed', legacyDir, targetDir, error: 'post-copy verification failed' };
    }

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
