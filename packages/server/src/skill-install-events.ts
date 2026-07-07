/**
 * Append-only telemetry writer for `~/.ok/skill-install-events.jsonl`.
 *
 * One JSONL line per install-related decision the server side observes:
 *   - track-1 (`installUserSkill`): `installed` | `skip-current` | `failed`
 *   - track-2 (`buildAndOpenSkill`): `installed` | `built` | `skip-current` | `failed`
 *
 * Distinct from the existing `~/.ok/stats.jsonl` (handoff-dispatch telemetry)
 * to preserve OK's "one concern per file" `~/.ok/` discipline — separate file,
 * no schema-coexistence risk with `HandoffStatsLine`.
 *
 * Fail-soft contract: NEVER throws. mkdir / append failures collapse to a
 * logger.warn + resolved void — telemetry must not affect install outcomes.
 * Mirrors `recordHandoff` discipline in `desktop/src/main/ipc-handlers.ts`.
 */

import { dirname, join } from 'node:path';
import type { BundleId } from './build-skill-zip.ts';
import { tracedMkdir, tracedWriteFile } from './fs-traced.ts';
import type { SkillStateLogger, SkillStateTarget } from './skill-state.ts';

/** File path relative to `$HOME` where install-state events are appended. */
export const SKILL_INSTALL_EVENTS_FILE_REL = ['.ok', 'skill-install-events.jsonl'] as const;

/**
 * What kind of install path observed the event. Vocabulary mirrors
 * `SkillStateSurface` in `@inkeep/open-knowledge-core` so readers across the
 * event log and the state file see one set of surfaces.
 */
export type SkillInstallEventSurface =
  /** HTTP path: `POST /api/install-skill` → `buildAndOpenSkill` (server). */
  | 'server-build-and-open'
  /** Electron bridge path: `okDesktop.skill.buildAndOpen` → `handleBuildAndOpen` (desktop main). */
  | 'electron-build-and-open'
  /** Track 1 install: `installUserSkill` → `npx skills add --agent '*' -g`. */
  | 'cli-npx-skills-add'
  /** Desktop main-process direct invoke of `installUserSkill` (first-launch flow). */
  | 'desktop-direct'
  /** CLI `ok start` boot-time reclaim sweep + standalone `ok repair-skills`. */
  | 'cli-start';

/** Per-event outcome — superset of both tracks' status unions. */
export type SkillInstallEventOutcome = 'installed' | 'built' | 'skip-current' | 'failed';

/** One line in the JSONL file. Schema is intentionally narrow. */
export interface SkillInstallEvent {
  /** ISO 8601 timestamp; caller-supplied so unit tests can pin it. */
  readonly ts: string;
  /** Which install surface emitted the event. */
  readonly surface: SkillInstallEventSurface;
  /**
   * Which target the event concerns. `claude-cowork` for track-2 builds;
   * `cli-hosts` for track-1 npx-skills installs.
   */
  readonly target: SkillStateTarget;
  /** Outcome bucket — see `SkillInstallEventOutcome`. */
  readonly outcome: SkillInstallEventOutcome;
  /**
   * Which skill bundle the event concerns. The user-global track installs
   * `discovery`; the project-local + Cowork tracks install `project`.
   * Optional — additive, absent on legacy events from before the split.
   */
  readonly bundle?: BundleId;
  /** Skill version recorded at the moment of the event. Optional on `failed`. */
  readonly version?: string;
  /** Failure reason — present only on `outcome: 'failed'`. */
  readonly reason?: string;
}

interface RecordSkillInstallEventDeps {
  /** `os.homedir()` — overridable in tests so a tmpdir stands in for `~`. */
  readonly homedir: () => string;
  /** Diagnostic sink — defaults to `console.warn`. */
  readonly warn?: SkillStateLogger['warn'];
}

/**
 * Append one event to `~/.ok/skill-install-events.jsonl`. Resolves to void
 * on every code path:
 *   - mkdir + append succeed → resolves
 *   - mkdir or append fails  → warn, resolves
 */
export async function recordSkillInstallEvent(
  event: SkillInstallEvent,
  deps?: Partial<RecordSkillInstallEventDeps>,
): Promise<void> {
  const homedirFn = deps?.homedir ?? (() => process.env.HOME ?? '');
  const warn =
    deps?.warn ??
    ((data: unknown, message: string) => {
      console.warn(message, data);
    });

  const home = homedirFn();
  if (!home) {
    warn(
      { event: 'skill-install-events.no-home' },
      '[skill-install-events] HOME not resolvable; telemetry skipped',
    );
    return;
  }
  const file = join(home, ...SKILL_INSTALL_EVENTS_FILE_REL);
  const json = `${JSON.stringify(event)}\n`;

  try {
    await tracedMkdir(dirname(file), { recursive: true });
  } catch (err) {
    warn(
      { event: 'skill-install-events.mkdir-failed', error: String(err) },
      '[skill-install-events] mkdir failed; telemetry skipped',
    );
    return;
  }

  // Append via flag: 'a' on tracedWriteFile. tracedWriteFile is the only
  // sanctioned write entry point per the AGENTS.md fs-traced STOP rule;
  // the write here is small (a single JSONL line) so the typical
  // appendFile vs writeFile cost difference is negligible.
  try {
    await tracedWriteFile(file, json, { flag: 'a', encoding: 'utf-8' });
  } catch (err) {
    warn(
      { event: 'skill-install-events.append-failed', error: String(err) },
      '[skill-install-events] append failed; telemetry skipped',
    );
  }
}
