/**
 * Collect active config diagnostics across every scope for the
 * config-diagnostics endpoint.
 *
 * Reads each layer's file fresh through `readConfigSafely` (no boot snapshot),
 * so an on-disk edit is reflected on the next call without a restart, and tags
 * each diagnostic with the scope and absolute file it came from. Reading is
 * non-destructive (`sideline: false`): a corrupt layer is reported, never
 * renamed, so querying diagnostics can't mutate a user's files.
 *
 * NOT browser-safe — routes through `readConfigSafely` (`node:fs`). Use only in
 * server / CLI contexts. Mirrors `inspect-config-paths.ts`.
 */

import type {
  ConfigDiagnostic,
  ConfigDiagnosticsReport,
  ScopedConfigDiagnostic,
  WriteScope,
} from './errors.ts';
import { readConfigSafely } from './read-config-safely.ts';
import { resolveConfigPath } from './write-config-patch.ts';

export interface CollectConfigDiagnosticsOptions {
  /** Project root — resolves the `project` and `project-local` layer files. */
  cwd: string;
  /** Home override for the `user` layer. Defaults to `os.homedir()`. */
  homedirOverride?: string;
  /**
   * Warn sink forwarded to `readConfigSafely`. Diagnostics are returned, so a
   * caller that only wants the structured result can pass a quiet sink to keep
   * a polled endpoint from re-logging on every request.
   */
  warn?: (message: string) => void;
}

/** The config layers the endpoint reports on, in resolution order. */
const DIAGNOSTIC_SCOPES = [
  'user',
  'project',
  'project-local',
] as const satisfies readonly WriteScope[];

/**
 * Read every config layer and return each layer's diagnostics tagged with its
 * scope and file. A read that only strips a removed key stays valid and still
 * contributes its `REMOVED_KEY` diagnostic; a corrupt layer contributes a
 * value-free `YAML_PARSE` / `SCHEMA_INVALID` finding.
 */
export function collectConfigDiagnostics(
  opts: CollectConfigDiagnosticsOptions,
): ConfigDiagnosticsReport {
  const diagnostics: ScopedConfigDiagnostic[] = [];
  for (const scope of DIAGNOSTIC_SCOPES) {
    const file = resolveConfigPath(scope, opts.cwd, opts.homedirOverride);
    const result = readConfigSafely({
      absPath: file,
      sideline: false,
      ...(opts.warn ? { warn: opts.warn } : {}),
    });
    for (const diagnostic of result.diagnostics) {
      diagnostics.push(toScoped(diagnostic, scope, file));
    }
  }
  return { diagnostics };
}

/**
 * Project a core `ConfigDiagnostic` onto the wire finding, dropping the
 * source-frame snippet the corruption variants carry so no raw config bytes
 * cross the boundary.
 */
function toScoped(
  diagnostic: ConfigDiagnostic,
  scope: WriteScope,
  file: string,
): ScopedConfigDiagnostic {
  switch (diagnostic.code) {
    case 'REMOVED_KEY':
      return {
        code: 'REMOVED_KEY',
        scope,
        file,
        path: diagnostic.path,
        redirect: diagnostic.redirect,
      };
    case 'YAML_PARSE':
      return { code: 'YAML_PARSE', scope, file };
    case 'SCHEMA_INVALID':
      return { code: 'SCHEMA_INVALID', scope, file };
    case 'UNREADABLE':
      return { code: 'UNREADABLE', scope, file };
  }
}
