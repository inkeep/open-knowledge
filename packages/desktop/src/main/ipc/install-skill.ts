/**
 * IPC handler implementations for the Claude Chat & Cowork skill install
 * dialog.
 *
 * Exposes two channels to the renderer:
 *   - `ok:skill:detect-claude-desktop` — boolean, via `detectClaudeDesktopPresence`
 *   - `ok:skill:build-and-open`        — build .skill locally + invoke OS file association,
 *                                        gated by the `claude-cowork` entry in
 *                                        `~/.ok/skill-state.yml`
 *
 * Builds the `.skill` artifact from the bundled skill source via
 * `buildSkillZip` in `@inkeep/open-knowledge-server`. No network round-trip,
 * no GitHub Releases dependency — the same SKILL.md that ships with the
 * Electron app's bundled CLI becomes the `.skill` file we hand off. Version
 * is guaranteed to match whatever the user has installed.
 *
 * The install-state gate covers the Cowork double-prompt bug across the web
 * tab + Electron app. Both surfaces share the `claude-cowork` entry in
 * `~/.ok/skill-state.yml` via the helpers in `@inkeep/open-knowledge-server`.
 *
 * The download-and-open handler is what unlocks the 2-click install UX:
 *   User clicks Install → gate check → if stale, build .skill →
 *   shell.openPath invokes Claude Desktop via its CFBundleDocumentType
 *   registration → Claude's native install dialog appears → user clicks
 *   Install → done.
 */

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
  /** Inject `electron.app` so tests can supply a fake downloads path. */
  app: Pick<App, 'getPath'>;
  /** Inject `electron.shell` so tests can assert on `openPath` calls. */
  shell: Pick<Shell, 'openPath'>;
  /** Override `$HOME` for the install-state file. Defaults to `os.homedir()`. */
  home?: string;
  /** When `true`, bypass the install-state gate and rebuild unconditionally
   * (reinstall affordance). */
  force?: boolean;
}

export { detectClaudeDesktopPresence as handleDetectClaudeDesktop } from '@inkeep/open-knowledge-server';

/**
 * `ok:skill:build-and-open` handler — gates against the `claude-cowork`
 * entry in `~/.ok/skill-state.yml`; if the recorded version matches the
 * current bundled skill, returns `{ ok: true, skipped: true }` without
 * rebuilding. Otherwise builds `openknowledge.skill` from the bundled
 * SKILL.md source, writes it to the user's Downloads folder, invokes the OS
 * file association, and records the new version on success.
 *
 * A successful (non-skipped) resolve means Claude Desktop has taken over;
 * the install flow continues inside Claude's own native install dialog.
 *
 * Telemetry: every outcome (skip / built / installed / failed) appends one
 * JSONL line to `~/.ok/skill-install-events.jsonl` via
 * `recordSkillInstallEvent`. Fail-soft (NEVER throws) per the recordHandoff
 * discipline.
 */
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

  // Install-state gate. Skip when `force: false` (default) AND the recorded
  // version matches the current bundled skill version. Read errors fall
  // through to a fresh build (fail-soft).
  if (!deps.force) {
    let currentVersion: string | null = null;
    try {
      currentVersion = await readServerPackageVersion();
    } catch (err) {
      // Could not read version — fall through to rebuild. Same posture as the
      // server-side `buildAndOpenSkill` gate.
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
        // Fall through to rebuild.
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

  // Write the install-state on every successful build, even if the OS
  // handoff fails afterward. The bundle is on disk; a future click should
  // skip the rebuild even if Claude Desktop didn't launch this time.
  // Write failures fall through (fail-soft) — gate works for this session
  // via the stale-version path; next session re-records.
  if (builtVersion) {
    try {
      await writeTargetVersion(home, 'claude-cowork', builtVersion, 'electron-build-and-open');
    } catch (err) {
      // Don't escalate — telemetry captures the write failure, the OS
      // handoff still proceeds, and the user gets the install dialog.
      // Worst case is one extra rebuild on next click.
      console.warn('[skill-install] state write failed:', err);
    }
  }

  // shell.openPath returns a string — empty on success, error description
  // on failure (Electron convention).
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
    // OS returned an error — most likely "no default handler for .skill"
    // if Claude Desktop isn't installed, or "file not found" (shouldn't
    // happen since we just wrote it). Surface the OS message.
    await report('built', builtVersion, `open-failed:${openError}`);
    return { ok: false, reason: 'open-failed', message: openError };
  }

  await report('installed', builtVersion);
  return { ok: true, path: outputPath };
}
