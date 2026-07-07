import { join } from 'node:path';
import { scaffoldLaunchJson } from '@inkeep/open-knowledge';

interface LaunchJsonWiringLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
}

const DEFAULT_LOGGER: LaunchJsonWiringLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
};

type LaunchJsonRepairResult =
  | { status: 'skipped'; reason: string }
  | { status: 'created'; configPath: string }
  | { status: 'merged'; configPath: string }
  | { status: 'failed'; configPath: string; error: string };

interface CheckAndRepairLaunchJsonOpts {
  projectDir: string;
  executablePath: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  logger?: LaunchJsonWiringLogger;
}

/**
 * Force-write the canonical `.claude/launch.json` `open-knowledge-ui`
 * configuration on every project open. Mirrors the user-level SKILL
 * force-write posture — no namespace-ownership classification, no
 * healthy-current short-circuit. `scaffoldLaunchJson` does the right thing
 * in each case it can reach:
 *
 *   - File missing → creates `.claude/launch.json` with our entry only.
 *   - File parses, no `open-knowledge-ui` entry → merges our entry into
 *     `configurations[]` (preserves siblings the user defined).
 *   - File parses, `open-knowledge-ui` entry exists → replaces it with the
 *     current bundled shape.
 *   - File exists but is blank/whitespace → `scaffoldLaunchJson` treats it
 *     as `{}` and writes a fresh file with our entry.
 *   - File exists but contains malformed JSON → `scaffoldLaunchJson`
 *     returns `'failed'`; we surface that as `status: 'failed'`. We do
 *     NOT backup-and-rewrite here — preserving siblings the user authored
 *     into a broken file outweighs the recovery-on-corrupt case. (Pure
 *     OK-managed files like SKILL.md and `.mcp.json` *do* get the
 *     backup-and-rewrite treatment; launch.json doesn't because it's a
 *     shared user-authored surface.)
 *
 * Idempotent: running twice in succession produces no diff on disk
 * because `scaffoldLaunchJson` writes byte-identical output on the second
 * call. CRDT-style force-write is fine here.
 */
export async function checkAndRepairLaunchJsonOnProjectOpen(
  opts: CheckAndRepairLaunchJsonOpts,
): Promise<LaunchJsonRepairResult> {
  const {
    projectDir,
    executablePath,
    isPackaged,
    platform,
    forceEnv,
    reclaimDisableEnv,
    logger = DEFAULT_LOGGER,
  } = opts;
  const configPath = join(projectDir, '.claude', 'launch.json');
  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  logger.event({ event: 'launch-json-wiring-repair-check-started', configPath });
  const result = scaffoldLaunchJson(projectDir, { mode: 'published' });
  if (result.action === 'failed') {
    logger.event({
      event: 'launch-json-wiring-repair-write-failed',
      configPath,
      error: result.error ?? 'unknown',
    });
    return { status: 'failed', configPath, error: result.error ?? 'unknown' };
  }
  logger.event({
    event:
      result.action === 'created'
        ? 'launch-json-wiring-repair-created'
        : 'launch-json-wiring-repair-merged',
    configPath,
  });
  return { status: result.action, configPath };
}
