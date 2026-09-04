import type {
  ConfigDiagnostic,
  ConfigDiagnosticsReport,
  ScopedConfigDiagnostic,
  WriteScope,
} from './errors.ts';
import { readConfigSafely } from './read-config-safely.ts';
import { resolveConfigPath } from './write-config-patch.ts';

export interface CollectConfigDiagnosticsOptions {
  cwd: string;
  homedirOverride?: string;
  warn?: (message: string) => void;
}

const DIAGNOSTIC_SCOPES = [
  'user',
  'project',
  'project-local',
] as const satisfies readonly WriteScope[];

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
