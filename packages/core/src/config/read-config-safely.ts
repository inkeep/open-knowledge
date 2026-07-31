/**
 * Safe config reader shared by every non-throwing read path (CLI user-global
 * layer, desktop utility process, server project + project-local layers).
 *
 * Always returns a usable `Config` plus structured `diagnostics`:
 *
 * - Removed keys (`REMOVED_KEY`) are stripped from the parsed value and
 *   reported as diagnostics; the file stays `valid` and every other key
 *   resolves to its on-disk value. A dead key can never change runtime
 *   behavior — by contract the engine no longer reads it — so it must never
 *   invalidate a sibling. The file is left in place (never sidelined);
 *   `ok config migrate` is the fix path.
 *
 * - Genuine corruption (`YAML_PARSE`, `SCHEMA_INVALID`) means the file cannot
 *   be trusted, so `valid` is false, `value` is schema defaults, and — when
 *   `sideline` is set — the file is renamed to `<path>.invalid-<ISO-timestamp>`
 *   so the server can still boot. If the rename fails (e.g. read-only
 *   filesystem), the original is left in place and a warning is logged.
 *
 * Sync rather than async because the loader path it feeds (`loadConfig`) is
 * sync and called from Commander.js's preAction hook. The fs ops here are a
 * single file read + at most one rename — sub-millisecond on any
 * non-pathological filesystem.
 */

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
      /**
       * Removed-key diagnostics; empty when the file carried no dead keys.
       * Narrower than the degraded arm's type on purpose: a valid read can only
       * ever report stripped keys, so a corruption code landing here is a type
       * error rather than something a caller has to notice at runtime.
       */
      diagnostics: RemovedKeyDiagnostic[];
    }
  | {
      valid: false;
      /** Schema defaults (always provided so callers can boot regardless). */
      value: Config;
      error: ConfigValidationError;
      /** Where the original broken file was sidelined to, if rename succeeded. */
      sidelinedTo?: string;
      /** Diagnostic mirroring the degradation (`YAML_PARSE` / `SCHEMA_INVALID`). */
      diagnostics: ConfigDiagnostic[];
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
    return { valid: true, value: defaults, source: undefined, diagnostics: [] };
  }

  // Read raw source.
  let source: string;
  try {
    source = readFileSync(absPath, 'utf-8');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    warn(`[config] Could not read ${absPath}: ${detail}. Using schema defaults.`);
    // A layer that could not be read at all must stay distinguishable from one
    // that read cleanly, or the reporting surfaces answer all-clear for it.
    const diagnostic: ConfigDiagnostic = { code: 'UNREADABLE', detail };
    return {
      valid: false,
      value: defaults,
      error: diagnostic,
      diagnostics: [{ ...diagnostic }],
    };
  }

  // Parse via Document (preserves source positions for issue location). A YAML
  // syntax error means the file cannot be trusted: sideline and boot on
  // defaults, unchanged from before strip-and-continue.
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
      // Copy rather than alias: `error` and `diagnostics` are independent
      // public fields, so a caller normalizing one must not mutate the other.
      diagnostics: [{ ...diagnostic }],
      ...(sidelinedTo !== undefined ? { sidelinedTo } : {}),
    };
  }

  const merged = doc.toJSON() ?? {};

  // Removed keys pass loose-mode schema validation silently. Detect them
  // against the original document (so diagnostics stay source-located), then
  // strip them from a clean copy and validate that copy — re-applying schema
  // defaults to the cleaned object. A removed key is never a reason to reject
  // the file: the engine no longer reads it, so stripping it cannot change the
  // resolved value of any live sibling.
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
    // Copied for the same reason as the YAML-parse arm above: `error` and
    // `diagnostics` must not share a mutable object across two public fields.
    // Removed keys detected before validation are still reported here — a
    // schema error elsewhere in the file must not hide them and force the user
    // into the two-trip fix cycle `detectRemovedKeys` exists to avoid.
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

  // Strip-and-continue: the file is valid, with any dead keys removed. The
  // dead keys are returned, not warned about. Several callers re-read config
  // fresh on every request, so warning here would emit the same multi-line
  // notice on every link hover or lint pass — and it would arrive under a
  // caller's "could not read" label for a read that succeeded. Reporting is
  // the caller's job, once, where it can reach a user.
  return { valid: true, value: parsed.data, source: absPath, diagnostics: removedKeyDiagnostics };
}
