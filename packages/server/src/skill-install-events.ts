
import { dirname, join } from 'node:path';
import type { BundleId } from './build-skill-zip.ts';
import { tracedMkdir, tracedWriteFile } from './fs-traced.ts';
import type { SkillStateLogger, SkillStateTarget } from './skill-state.ts';

export const SKILL_INSTALL_EVENTS_FILE_REL = ['.ok', 'skill-install-events.jsonl'] as const;

export type SkillInstallEventSurface =
  | 'server-build-and-open'
  | 'electron-build-and-open'
  | 'cli-npx-skills-add'
  | 'desktop-direct'
  | 'cli-start';

export type SkillInstallEventOutcome = 'installed' | 'built' | 'skip-current' | 'failed';

export interface SkillInstallEvent {
  readonly ts: string;
  readonly surface: SkillInstallEventSurface;
  readonly target: SkillStateTarget;
  readonly outcome: SkillInstallEventOutcome;
  readonly bundle?: BundleId;
  readonly version?: string;
  readonly reason?: string;
}

interface RecordSkillInstallEventDeps {
  readonly homedir: () => string;
  readonly warn?: SkillStateLogger['warn'];
}

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

  try {
    await tracedWriteFile(file, json, { flag: 'a', encoding: 'utf-8' });
  } catch (err) {
    warn(
      { event: 'skill-install-events.append-failed', error: String(err) },
      '[skill-install-events] append failed; telemetry skipped',
    );
  }
}
