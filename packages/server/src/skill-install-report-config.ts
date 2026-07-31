/**
 * Resolve `telemetry.skillInstallReports.enabled` from the USER config.
 *
 * Read as raw YAML rather than through the schema reader for the same reason
 * `local-sink-resolver.ts` does: a schema-defaulted read cannot tell "absent"
 * from "explicitly true", and this is a setting where an explicit `false` must
 * win over anything. Absent → the schema default (on).
 *
 * User scope, not project: a repository must not be able to decide that its
 * collaborators' machines report to a third party.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './logger.ts';

export interface SkillInstallReportSettings {
  enabled: boolean;
  home: string;
}

/**
 * Never throws: telemetry bookkeeping must not be able to break an install.
 *
 * A config that EXISTS but cannot be read or parsed resolves to DISABLED, not
 * to the default. The default is only correct when we know the user expressed
 * no preference — an absent file. If the file is there and unreadable, an
 * explicit `enabled: false` may be sitting inside it, and the failure direction
 * that matters for a setting governing what leaves the machine is "say nothing"
 * rather than "assume consent". The mirror of the opt-out gate in
 * `installUserSkill`: unknowable means decline.
 */
export function resolveSkillInstallReportSettings(
  homedirOverride?: string,
): SkillInstallReportSettings {
  const home = homedirOverride ?? homedir();
  let path: string;
  try {
    path = resolveConfigPath('user', home, home);
  } catch (err) {
    getLogger('skills').warn({ err }, 'could not resolve the user config path; not reporting');
    return { enabled: false, home };
  }
  // No file at all: the user has expressed no preference, so the schema default
  // (on) applies — same reading the Settings pane shows them.
  if (!existsSync(path)) return { enabled: true, home };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) as
      | { telemetry?: { skillInstallReports?: { enabled?: unknown } } }
      | null
      | undefined;
    const value = raw?.telemetry?.skillInstallReports?.enabled;
    return { enabled: typeof value === 'boolean' ? value : true, home };
  } catch (err) {
    getLogger('skills').warn(
      { err, path },
      'user config exists but could not be read; not reporting skill installs',
    );
    return { enabled: false, home };
  }
}
