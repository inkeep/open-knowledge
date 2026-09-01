import type { Document } from 'yaml';
import { mechanicalEnvName, RECOGNIZED_ENV_VARS } from './env-layer.ts';
import type { ConfigIssueSource } from './errors.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';
import { locateIssue } from './source-locator.ts';

export interface IgnoredCommittedKey {
  path: string[];
  envVar?: string;
  source?: ConfigIssueSource;
}

export interface DetectCommittedProjectLocalKeysInput {
  value: unknown;
  file?: string | null;
  source?: string | null;
  doc?: Document | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function detectCommittedProjectLocalKeys(
  input: DetectCommittedProjectLocalKeysInput,
): IgnoredCommittedKey[] {
  const { value, file, source, doc } = input;
  const findings: IgnoredCommittedKey[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (path.length > 0) {
      const meta = getLeafFieldMeta(ConfigSchema, path);
      if (meta !== undefined) {
        if (meta.scope === 'project-local') {
          const envVar = mechanicalEnvName(path);
          let located: ConfigIssueSource | undefined;
          if (doc != null && source != null && file != null) {
            located = locateIssue({ file, source, doc, path });
          }
          findings.push({
            path: [...path],
            ...(RECOGNIZED_ENV_VARS.has(envVar) ? { envVar } : {}),
            ...(located !== undefined ? { source: located } : {}),
          });
        }
        return;
      }
    }
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    }
  };

  walk(value, []);
  return findings;
}

export function formatIgnoredCommittedKey(key: IgnoredCommittedKey): string {
  const dotted = key.path.join('.');
  const location =
    key.source !== undefined ? `${key.source.file}:${key.source.line}:${key.source.column}: ` : '';
  const envHint = key.envVar !== undefined ? `, or set ${key.envVar} on this host` : '';
  return `${location}${dotted} is a per-machine (project-local) setting; the value committed in .ok/config.yml is ignored. Set it in .ok/local/config.yml (this machine only)${envHint}.`;
}
