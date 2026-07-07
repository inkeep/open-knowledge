/**
 * Cold-start recovery for invalid config files.
 *
 * Reads a config file, validates it against `ConfigSchema`, and on failure
 * sidelines the broken file (rename to `<path>.invalid-<ISO-timestamp>`) so
 * the server can boot on schema defaults. If the rename itself fails (e.g.,
 * read-only filesystem), the original file is left in place and a warning
 * is logged.
 *
 * Used at boot for `~/.ok/global.yml` (the user-global path).
 * The project path uses the regular loader because project errors are
 * user-fixable in-place — failing fast helps the user notice. User-global
 * errors block every OK boot until manually repaired, so the recovery path
 * is the right default there.
 *
 * Sync rather than async because the loader path it feeds (`loadConfig`)
 * is sync and called from Commander.js's preAction hook. The fs ops here
 * are a single file read + at most one rename — sub-millisecond on any
 * non-pathological filesystem.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { type Document, parseDocument } from 'yaml';
import { type ConfigIssue, type ConfigValidationError, humanFormat } from './errors.ts';
import { detectRemovedKeys } from './removed-keys.ts';
import { type Config, ConfigSchema } from './schema.ts';
import { locateIssue } from './source-locator.ts';

export interface ReadConfigSafelyOptions {
  /** Absolute path to the config file. May or may not exist. */
  absPath: string;
  /**
   * If `true` (default), invalid files are renamed to
   * `<absPath>.invalid-<ISO-timestamp>`. Pass `false` to leave the file
   * in place and only log warnings (used by tests + cases where the caller
   * wants to inspect the broken file before deciding).
   */
  sideline?: boolean;
  /**
   * Override the timestamp string used in sideline filenames. Defaults to
   * `new Date().toISOString()`. Test seam.
   */
  timestamp?: string;
  /**
   * Override the warn logger. Defaults to `console.warn`. Test seam.
   */
  warn?: (message: string) => void;
}

export type ReadConfigSafelyResult =
  | {
      valid: true;
      value: Config;
      /** Absolute path of the file that was read. `undefined` when missing. */
      source?: string;
    }
  | {
      valid: false;
      /** Schema defaults (always provided so callers can boot regardless). */
      value: Config;
      error: ConfigValidationError;
      /** Where the original broken file was sidelined to, if rename succeeded. */
      sidelinedTo?: string;
    };

/**
 * Build the typed `ConfigValidationError` for a failed safeParse, with
 * `source` annotated on each issue using the supplied Document AST.
 */
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

/**
 * Attempt to sideline the broken file by renaming it. Returns the new path
 * on success; returns `undefined` on failure (and logs a warning).
 */
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

/**
 * Read + validate a config file. Always returns a `Config` value; on failure,
 * `value` is the schema defaults so the caller can boot.
 */
export function readConfigSafely(options: ReadConfigSafelyOptions): ReadConfigSafelyResult {
  const { absPath, sideline = true, timestamp = new Date().toISOString() } = options;
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const defaults = ConfigSchema.parse({});

  // Missing file: no error, just defaults. The loader's existing semantic.
  if (!existsSync(absPath)) {
    return { valid: true, value: defaults, source: undefined };
  }

  // Read raw source.
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    warn(`[config] Could not read ${absPath}: ${detail}. Using schema defaults.`);
    return {
      valid: false,
      value: defaults,
      error: { code: 'UNKNOWN', message: `Read failed: ${detail}` },
    };
  }

  // Parse via Document (preserves source positions for issue location).
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    const detail = doc.errors.map((e) => e.message).join('; ');
    warn(
      `[config] ${absPath} contains invalid YAML (${detail}). Using schema defaults.` +
        (sideline ? '' : ' Pass-through mode: file left in place.'),
    );
    const sidelinedTo = sideline ? attemptSideline(absPath, timestamp, warn) : undefined;
    return {
      valid: false,
      value: defaults,
      error: { code: 'YAML_PARSE', detail },
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  // Validate against ConfigSchema.
  const merged = doc.toJSON() ?? {};
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const error = buildSchemaInvalidError(parsed, doc, source, absPath);
    warn(
      `[config] ${absPath} fails schema validation (${parsed.error.issues.length} issue(s)). Using schema defaults.` +
        (sideline ? '' : ' Pass-through mode: file left in place.'),
    );
    const sidelinedTo = sideline ? attemptSideline(absPath, timestamp, warn) : undefined;
    return {
      valid: false,
      value: defaults,
      error,
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  // Removed keys pass loose-mode schema validation silently. Reject them here
  // so a stale file is sidelined and boots on defaults rather than applying a
  // no-op key the user believes took effect. This is the recovery path
  // (user-global `~/.ok/global.yml`); the project loader fails loud instead so
  // a user-fixable file gets fixed.
  const removedKeyErrors = detectRemovedKeys({ value: merged, file: absPath, source, doc });
  const firstRemovedKeyError = removedKeyErrors[0];
  if (firstRemovedKeyError !== undefined) {
    warn(
      `[config] ${absPath} carries removed config key(s):\n` +
        `${removedKeyErrors.map(humanFormat).join('\n\n')}\n` +
        `Using schema defaults.` +
        (sideline ? '' : ' Pass-through mode: file left in place.'),
    );
    const sidelinedTo = sideline ? attemptSideline(absPath, timestamp, warn) : undefined;
    return {
      valid: false,
      value: defaults,
      error: firstRemovedKeyError,
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  return { valid: true, value: parsed.data, source: absPath };
}
