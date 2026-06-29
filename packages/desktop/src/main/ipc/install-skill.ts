
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillZip,
  readServerPackageVersion,
  readTargetRecordedAt,
  readTargetVersion,
  recordSkillInstallEvent,
  type SkillInstallEventOutcome,
  writeTargetVersion,
} from '@inkeep/open-knowledge-server';
import type { App, Shell } from 'electron';

export type BuildAndOpenResult =
  | { ok: true; path: string; skipped?: false; version?: string }
  | { ok: true; path?: undefined; skipped: true; version: string; recordedAt?: string }
  | {
      ok: false;
      reason: 'build-failed' | 'open-failed' | 'no-downloads-dir';
      message?: string;
    };

interface InstallSkillIpcDeps {
  app: Pick<App, 'getPath'>;
  shell: Pick<Shell, 'openPath'>;
  home?: string;
  /** When `true`, bypass the install-state gate and rebuild unconditionally
   * (reinstall affordance). */
  force?: boolean;
}

export { detectClaudeDesktopPresence as handleDetectClaudeDesktop } from '@inkeep/open-knowledge-server';

export async function handleBuildAndOpen(deps: InstallSkillIpcDeps): Promise<BuildAndOpenResult> {
  const home = deps.home ?? homedir();

  const report = async (
    outcome: SkillInstallEventOutcome,
    version?: string,
    reason?: string,
  ): Promise<void> => {
    await recordSkillInstallEvent(
      {
        ts: new Date().toISOString(),
        surface: 'electron-build-and-open',
        target: 'claude-cowork',
        outcome,
        ...(version !== undefined ? { version } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
      { homedir: () => home },
    );
  };

  let downloadsDir: string;
  try {
    downloadsDir = deps.app.getPath('downloads');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `no-downloads-dir:${message}`);
    return {
      ok: false,
      reason: 'no-downloads-dir',
      message,
    };
  }

  const outputPath = join(downloadsDir, 'openknowledge.skill');

  if (!deps.force) {
    let currentVersion: string | null = null;
    try {
      currentVersion = await readServerPackageVersion();
    } catch (err) {
      console.warn('[skill-install] could not read server package version; rebuilding:', err);
    }
    if (currentVersion !== null) {
      let recordedVersion: string | null = null;
      let recordedAt: string | null = null;
      try {
        [recordedVersion, recordedAt] = await Promise.all([
          readTargetVersion(home, 'claude-cowork'),
          readTargetRecordedAt(home, 'claude-cowork'),
        ]);
      } catch (err) {
        console.warn(
          '[skill-install] could not read claude-cowork install-state; rebuilding:',
          err,
        );
      }
      if (recordedVersion !== null && recordedVersion === currentVersion) {
        await report('skip-current', currentVersion);
        return {
          ok: true,
          skipped: true,
          version: currentVersion,
          ...(recordedAt !== null ? { recordedAt } : {}),
        };
      }
    }
  }

  let builtVersion: string | undefined;
  try {
    const build = await buildSkillZip({ outputPath });
    builtVersion = build.skillVersion;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('failed', undefined, `build-failed:${message}`);
    return {
      ok: false,
      reason: 'build-failed',
      message,
    };
  }

  if (builtVersion) {
    try {
      await writeTargetVersion(home, 'claude-cowork', builtVersion, 'electron-build-and-open');
    } catch (err) {
      console.warn('[skill-install] state write failed:', err);
    }
  }

  let openError: string;
  try {
    openError = await deps.shell.openPath(outputPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report('built', builtVersion, `open-failed:${message}`);
    return {
      ok: false,
      reason: 'open-failed',
      message,
    };
  }
  if (openError !== '') {
    await report('built', builtVersion, `open-failed:${openError}`);
    return { ok: false, reason: 'open-failed', message: openError };
  }

  await report('installed', builtVersion);
  return { ok: true, path: outputPath };
}
