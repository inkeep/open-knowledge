/**
 * `config-yaml` check — verifies the project's `.ok/config.yml` parses against
 * `ConfigSchema`. Emits `warn` (NOT `fail`) when the project isn't initialized
 * (no `.ok/config.yml`), so health checks double as a pre-`ok init` sanity
 * surface — a developer can run them from a fresh directory to confirm git +
 * Bun are available before scaffolding.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../config/loader.ts';
import { CONFIG_FILENAME, OK_DIR } from '../../constants.ts';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

interface ConfigYamlCheckDeps {
  loader?: (cwd: string) => { sources: string[]; config: { content: { dir: string } } };
}

export function makeConfigYamlCheck(deps: ConfigYamlCheckDeps = {}): CheckDefinition {
  const load = deps.loader ?? loadConfig;
  return {
    name: 'config-yaml',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const configPath = resolve(ctx.cwd, OK_DIR, CONFIG_FILENAME);
      if (!existsSync(configPath)) {
        return {
          name: 'config-yaml',
          status: 'warn',
          summary: `${OK_DIR}/${CONFIG_FILENAME} not found (project not initialized)`,
          remediation: `Run \`ok init\` to scaffold the project.`,
        };
      }
      try {
        const { config, sources } = load(ctx.cwd);
        return {
          name: 'config-yaml',
          status: 'pass',
          summary: `parses; content.dir = ${config.content.dir}`,
          detail: `sources: ${sources.join(', ')}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          name: 'config-yaml',
          status: 'fail',
          summary: `${OK_DIR}/${CONFIG_FILENAME} failed to parse`,
          detail: message,
        };
      }
    },
  };
}
