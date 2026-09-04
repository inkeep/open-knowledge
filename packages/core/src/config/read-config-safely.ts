import { existsSync, readFileSync, renameSync } from 'node:fs';
import { type Document, parseDocument } from 'yaml';
import {
  type ConfigDiagnostic,
  type ConfigIssue,
  type ConfigValidationError,
  isKnownConfigError,
  type RemovedKeyDiagnostic,
} from './errors.ts';
import { detectRemovedKeys, stripRemovedKeys } from './removed-keys.ts';
import { type Config, ConfigSchema } from './schema.ts';
import { locateIssue } from './source-locator.ts';

export interface ReadConfigSafelyOptions {
  absPath: string;
  sideline?: boolean;
  timestamp?: string;
  warn?: (message: string) => void;
}

export type ReadConfigSafelyResult =
  | {
      valid: true;
      value: Config;
      source?: string;
      diagnostics: RemovedKeyDiagnostic[];
    }
  | {
      valid: false;
      value: Config;
      error: ConfigValidationError;
      sidelinedTo?: string;
      diagnostics: ConfigDiagnostic[];
    };

function buildSchemaInvalidError(
  parsed: ReturnType<typeof ConfigSchema.safeParse>,
  doc: Document,
  source: string,
  absPath: string,
): ConfigValidationError {
  if (parsed.success) {
    return { code: 'UNKNOWN', message: 'unexpected success in error path' };
  }
  const issues: ConfigIssue[] = parsed.error.issues.map((issue) => {
    const path = issue.path.map((seg) =>
      typeof seg === 'symbol' ? String(seg) : (seg as string | number),
    );
    const located = locateIssue({ file: absPath, source, doc, path });
    return {
      path,
      message: issue.message,
      issueCode: issue.code,
      ...(located !== undefined ? { source: located } : {}),
    };
  });
  return { code: 'SCHEMA_INVALID', issues };
}

function attemptSideline(
  absPath: string,
  timestamp: string,
  warn: (message: string) => void,
): string | undefined {
  const sidelineTarget = `${absPath}.invalid-${timestamp.replace(/[:.]/g, '-')}`;
  try {
    renameSync(absPath, sidelineTarget);
    return sidelineTarget;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    warn(
      `[config] Could not sideline invalid config file ${absPath} → ${sidelineTarget}: ${detail}. ` +
        'File left in place; using schema defaults.',
    );
    return undefined;
  }
}

export function readConfigSafely(options: ReadConfigSafelyOptions): ReadConfigSafelyResult {
  const { absPath, sideline = true, timestamp = new Date().toISOString() } = options;
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const defaults = ConfigSchema.parse({});

  if (!existsSync(absPath)) {
    return { valid: true, value: defaults, source: undefined, diagnostics: [] };
  }

  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    warn(`[config] Could not read ${absPath}: ${detail}. Using schema defaults.`);
    const diagnostic: ConfigDiagnostic = { code: 'UNREADABLE', detail };
    return {
      valid: false,
      value: defaults,
      error: diagnostic,
      diagnostics: [{ ...diagnostic }],
    };
  }

  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    const detail = doc.errors.map((e) => e.message).join('; ');
    warn(
      `[config] ${absPath} contains invalid YAML (${detail}). Using schema defaults.` +
        (sideline ? '' : ' Pass-through mode: file left in place.'),
    );
    const sidelinedTo = sideline ? attemptSideline(absPath, timestamp, warn) : undefined;
    const diagnostic: ConfigDiagnostic = { code: 'YAML_PARSE', detail };
    return {
      valid: false,
      value: defaults,
      error: diagnostic,
      diagnostics: [{ ...diagnostic }],
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  const merged = doc.toJSON() ?? {};

  const removedKeyDiagnostics = detectRemovedKeys({ value: merged, file: absPath, source, doc });
  const cleaned = removedKeyDiagnostics.length > 0 ? stripRemovedKeys(merged) : merged;

  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const error = buildSchemaInvalidError(parsed, doc, source, absPath);
    warn(
      `[config] ${absPath} fails schema validation (${parsed.error.issues.length} issue(s)). Using schema defaults.` +
        (sideline ? '' : ' Pass-through mode: file left in place.'),
    );
    const sidelinedTo = sideline ? attemptSideline(absPath, timestamp, warn) : undefined;
    const diagnostics: ConfigDiagnostic[] = [
      ...removedKeyDiagnostics,
      ...(isKnownConfigError(error) && error.code === 'SCHEMA_INVALID' ? [{ ...error }] : []),
    ];
    return {
      valid: false,
      value: defaults,
      error,
      diagnostics,
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  return { valid: true, value: parsed.data, source: absPath, diagnostics: removedKeyDiagnostics };
}
