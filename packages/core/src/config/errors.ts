import { z } from 'zod';

export const ConfigIssueSourceSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  snippet: z.string().optional(),
});

export type ConfigIssueSource = z.infer<typeof ConfigIssueSourceSchema>;

export const ConfigIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  issueCode: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  source: ConfigIssueSourceSchema.optional(),
});

export type ConfigIssue = z.infer<typeof ConfigIssueSchema>;

export const FieldScopeSchema = z.enum(['user', 'project', 'project-local', 'either']);
export type FieldScope = z.infer<typeof FieldScopeSchema>;

export const WriteScopeSchema = z.enum(['user', 'project', 'project-local']);
export type WriteScope = z.infer<typeof WriteScopeSchema>;

const YamlParseErrorSchema = z.object({
  code: z.literal('YAML_PARSE'),
  detail: z.string(),
});
const UnreadableErrorSchema = z.object({
  code: z.literal('UNREADABLE'),
  detail: z.string(),
});
const SchemaInvalidErrorSchema = z.object({
  code: z.literal('SCHEMA_INVALID'),
  issues: z.array(ConfigIssueSchema),
});
const RemovedKeyErrorSchema = z.object({
  code: z.literal('REMOVED_KEY'),
  path: z.array(z.string()),
  redirect: z.string(),
  source: ConfigIssueSourceSchema.optional(),
});

export const KnownConfigValidationErrorSchema = z.discriminatedUnion('code', [
  YamlParseErrorSchema,
  SchemaInvalidErrorSchema,
  UnreadableErrorSchema,
  z.object({
    code: z.literal('SCOPE_VIOLATION'),
    path: z.array(z.string()),
    expectedScope: FieldScopeSchema,
    actualScope: WriteScopeSchema,
  }),
  z.object({
    code: z.literal('NOT_AGENT_SETTABLE'),
    path: z.array(z.string()),
  }),
  z.object({
    code: z.literal('MIXED_SCOPE'),
    paths: z.array(
      z.object({
        path: z.array(z.string()),
        scope: WriteScopeSchema,
      }),
    ),
  }),
  RemovedKeyErrorSchema,
  z.object({
    code: z.literal('WRITE_ERROR'),
    detail: z.string(),
  }),
  z.object({
    code: z.literal('OKIGNORE_INVALID'),
    detail: z.string(),
    lineNumber: z.number().int().min(1).optional(),
  }),
  z.object({
    code: z.literal('UNKNOWN'),
    message: z.string().optional(),
  }),
]);

export type KnownConfigValidationError = z.infer<typeof KnownConfigValidationErrorSchema>;

export const ConfigDiagnosticSchema = z.discriminatedUnion('code', [
  RemovedKeyErrorSchema,
  YamlParseErrorSchema,
  SchemaInvalidErrorSchema,
  UnreadableErrorSchema,
]);

export type ConfigDiagnostic = z.infer<typeof ConfigDiagnosticSchema>;

export type RemovedKeyDiagnostic = Extract<ConfigDiagnostic, { code: 'REMOVED_KEY' }>;

export const ScopedConfigDiagnosticSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('REMOVED_KEY'),
    scope: WriteScopeSchema,
    file: z.string(),
    path: z.array(z.string()),
    redirect: z.string(),
  }),
  z.object({
    code: z.literal('YAML_PARSE'),
    scope: WriteScopeSchema,
    file: z.string(),
  }),
  z.object({
    code: z.literal('SCHEMA_INVALID'),
    scope: WriteScopeSchema,
    file: z.string(),
  }),
  z.object({
    code: z.literal('UNREADABLE'),
    scope: WriteScopeSchema,
    file: z.string(),
  }),
]);

export type ScopedConfigDiagnostic = z.infer<typeof ScopedConfigDiagnosticSchema>;

export const ConfigDiagnosticsReportSchema = z.object({
  diagnostics: z.array(ScopedConfigDiagnosticSchema),
});

export type ConfigDiagnosticsReport = z.infer<typeof ConfigDiagnosticsReportSchema>;

const KNOWN_CONFIG_ERROR_CODES: ReadonlySet<string> = new Set(
  KnownConfigValidationErrorSchema.options.map((opt) => opt.shape.code.value),
);

export const ForwardCompatConfigErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
});

export type ForwardCompatConfigError = z.infer<typeof ForwardCompatConfigErrorSchema>;

export const ConfigValidationErrorSchema = z.union([
  KnownConfigValidationErrorSchema,
  ForwardCompatConfigErrorSchema,
]);

export type ConfigValidationError = KnownConfigValidationError | ForwardCompatConfigError;

export function isKnownConfigError(
  error: ConfigValidationError,
): error is KnownConfigValidationError {
  return KNOWN_CONFIG_ERROR_CODES.has(error.code);
}

function scopeConfigFile(scope: FieldScope): string {
  switch (scope) {
    case 'user':
      return '~/.ok/global.yml';
    case 'project':
      return '.ok/config.yml';
    case 'project-local':
      return '.ok/local/config.yml';
    case 'either':
      return '.ok/config.yml or ~/.ok/global.yml';
  }
}

function scopeGloss(scope: FieldScope): string {
  switch (scope) {
    case 'user':
      return 'personal to you, across all projects';
    case 'project':
      return 'shared with your team via git';
    case 'project-local':
      return 'this machine only, not shared';
    case 'either':
      return 'user or project';
  }
}

export function humanFormat(error: ConfigValidationError): string {
  if (!isKnownConfigError(error)) {
    return error.message ?? `Unknown error (${error.code}).`;
  }
  switch (error.code) {
    case 'YAML_PARSE':
      return `Failed to parse YAML: ${error.detail}`;
    case 'UNREADABLE':
      return `Could not read the file: ${error.detail}`;
    case 'SCHEMA_INVALID': {
      if (error.issues.length === 0) return 'Invalid configuration.';
      const grouped = new Map<string, ConfigIssue[]>();
      for (const iss of error.issues) {
        const key = iss.source?.file ?? '<no source>';
        const list = grouped.get(key) ?? [];
        list.push(iss);
        grouped.set(key, list);
      }
      const lines: string[] = [];
      for (const [file, issues] of grouped) {
        if (file === '<no source>') {
          lines.push('Invalid configuration:');
        } else {
          lines.push(`Invalid configuration at ${file}:`);
        }
        for (const iss of issues) {
          const path = iss.path.length === 0 ? '<root>' : iss.path.join('.');
          if (iss.source) {
            lines.push(`  ${file}:${iss.source.line}:${iss.source.column}`);
            lines.push(`  ${path}: ${iss.message}`);
            if (iss.source.snippet && iss.source.snippet.length > 0) {
              for (const snippetLine of iss.source.snippet.split('\n')) {
                lines.push(`    ${snippetLine}`);
              }
            }
          } else {
            lines.push(`  ${path}: ${iss.message}`);
          }
        }
      }
      return lines.join('\n');
    }
    case 'SCOPE_VIOLATION':
      return [
        `Setting ${error.path.join('.')} belongs in your ${error.expectedScope} config`,
        `(${scopeConfigFile(error.expectedScope)} — ${scopeGloss(error.expectedScope)}),`,
        `but it was set in the ${error.actualScope} config (${scopeConfigFile(error.actualScope)}).`,
        `Move it to ${scopeConfigFile(error.expectedScope)}.`,
      ].join(' ');
    case 'NOT_AGENT_SETTABLE':
      return [
        `Setting ${error.path.join('.')} is human-only and can't be changed by an agent.`,
        'Change it in the Settings pane, or edit the config.yml by hand.',
      ].join(' ');
    case 'MIXED_SCOPE': {
      const summary = error.paths
        .map(({ path, scope }) => `  ${path.join('.')} → ${scopeConfigFile(scope)} (${scope})`)
        .join('\n');
      return [
        'This change touches settings that live in different config files. Apply them one file at a time:',
        summary,
      ].join('\n');
    }
    case 'REMOVED_KEY': {
      const path = error.path.join('.');
      const header = error.source
        ? `Removed key at ${error.source.file}:${error.source.line}:${error.source.column}`
        : 'Removed key in configuration';
      const lines = [`${header}: ${path}`, error.redirect];
      if (error.source?.snippet && error.source.snippet.length > 0) {
        for (const snippetLine of error.source.snippet.split('\n')) {
          lines.push(`  ${snippetLine}`);
        }
      }
      return lines.join('\n');
    }
    case 'WRITE_ERROR':
      return `Failed to write config file: ${error.detail}`;
    case 'OKIGNORE_INVALID':
      return error.lineNumber !== undefined
        ? `.okignore line ${error.lineNumber}: ${error.detail}`
        : `.okignore: ${error.detail}`;
    case 'UNKNOWN':
      return error.message ?? 'Unknown error.';
  }
}
