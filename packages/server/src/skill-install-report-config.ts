import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './logger.ts';

function schemaDefaultEnabled(): boolean {
  return ConfigSchema.parse({}).telemetry.skillInstallReports.enabled;
}

export interface SkillInstallReportSettings {
  enabled: boolean;
  home: string;
}

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
  if (!existsSync(path)) return { enabled: schemaDefaultEnabled(), home };
  try {
    const raw = parseYaml(readFileSync(path, 'utf-8')) as
      | { telemetry?: { skillInstallReports?: { enabled?: unknown } } }
      | null
      | undefined;
    const value = raw?.telemetry?.skillInstallReports?.enabled;
    return { enabled: typeof value === 'boolean' ? value : schemaDefaultEnabled(), home };
  } catch (err) {
    getLogger('skills').warn(
      { err, path },
      'user config exists but could not be read; not reporting skill installs',
    );
    return { enabled: false, home };
  }
}
