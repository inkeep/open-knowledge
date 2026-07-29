/**
 * Bundle content-dir masker. Walks the staged copies of telemetry / log / state
 * files and replaces the absolute content-dir path, wherever it appears as a
 * substring of any string value, with the literal token `<CONTENT_DIR>` — so a
 * shared bundle doesn't leak the user's home-directory layout.
 *
 * Mutates the staged copies in place; the originals under
 * `<contentDir>/.ok/local/{telemetry,logs}/` are untouched — the collector
 * already stages copies before invoking this module.
 *
 * Doc names / titles are NOT anonymized here: they ship raw under the user's
 * explicit Detailed-diagnostics consent. Credentials are scrubbed by the
 * separate secret-pattern pass (`scrubStagedSecrets`), which rides the same
 * `redact` switch this masker does. Every sharing surface (`ok bug-report`,
 * the in-app bug report) pins that switch on; `ok diagnose bundle --no-redact`
 * is the one opt-out, and it produces a deliberately raw local dump where a
 * token stays legible because a bundle that quietly mangles credentials cannot
 * be used to diagnose an auth failure. The `ok diagnose bundle` consent
 * summary states which of the two the user is about to write.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONTENT_DIR_TOKEN = '<CONTENT_DIR>';

export interface RedactStagedBundleOpts {
  /** Absolute path to the staging dir (contains telemetry/, logs/, state/). */
  stagingDir: string;
  /** Absolute content-dir path to substitute with `<CONTENT_DIR>`. */
  contentDir: string;
}

interface RedactCtx {
  contentDir: string;
}

function replaceContentDir(value: string, contentDir: string): string {
  // Empty contentDir would otherwise insert the token between every char via
  // split('').join(token). Defensive guard — production callers always pass an
  // absolute path, but unit fixtures and a degenerate config could trigger it.
  if (contentDir.length === 0) return value;
  if (!value.includes(contentDir)) return value;
  return value.split(contentDir).join(CONTENT_DIR_TOKEN);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively mask a parsed JSON node. Returns a new tree; does not mutate the
 * input. Every string leaf gets the content-dir substring substitution; the
 * structural walk (rather than a whole-file string replace) keeps the mask
 * correct when the path is JSON-escaped, e.g. a backslash-separated Windows
 * path stored as `\\` inside a JSON string.
 */
function redactValue(node: unknown, ctx: RedactCtx): unknown {
  if (typeof node === 'string') {
    return replaceContentDir(node, ctx.contentDir);
  }
  if (Array.isArray(node)) {
    return node.map((item) => redactValue(item, ctx));
  }
  if (!isObject(node)) {
    return node;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    result[k] = redactValue(v, ctx);
  }
  return result;
}

function redactJsonlFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  if (content.length === 0) return;
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === lines.length - 1 && line === '') continue;
    if (line.length === 0) {
      out.push('');
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const redacted = redactValue(parsed, ctx);
      out.push(JSON.stringify(redacted));
    } catch {
      // Partial-write resilience: an unparseable trailing fragment from a
      // mid-write SIGKILL is kept as-is. Tagging it would risk further
      // corruption; consumers already skip unparseable lines.
      out.push(line);
    }
  }
  const newContent = hasTrailingNewline ? `${out.join('\n')}\n` : out.join('\n');
  writeFileSync(filePath, newContent);
}

function redactJsonFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  if (content.trim().length === 0) return;
  try {
    const parsed = JSON.parse(content);
    const redacted = redactValue(parsed, ctx);
    const trailingNewline = content.endsWith('\n') ? '\n' : '';
    writeFileSync(filePath, `${JSON.stringify(redacted, null, 2)}${trailingNewline}`);
  } catch {
    // Whole-file JSON parse failure (truncated write, manual edit, etc.): fall
    // back to a plain substring substitution so a corrupt state file still has
    // the content-dir prefix masked.
    const replaced = replaceContentDir(content, ctx.contentDir);
    if (replaced !== content) writeFileSync(filePath, replaced);
  }
}

function redactPlainFile(filePath: string, ctx: RedactCtx): void {
  const content = readFileSync(filePath, 'utf-8');
  const replaced = replaceContentDir(content, ctx.contentDir);
  if (replaced !== content) writeFileSync(filePath, replaced);
}

function walkDirFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name));
  } catch {
    // Dir doesn't exist (nothing staged for that subdir) — nothing to mask.
    return [];
  }
}

// State files that are JSON-shaped get a full walker pass (runtime.json may
// carry the contentDir). Other state files get whole-content substitution.
const STATE_JSON_FILES = new Set(['agent-presence.json', 'agent-effects.json', 'runtime.json']);

/**
 * Rotated log files carry their counter where the extension would be
 * (`desktop.2026-07-28.log.3`), so any suffix test has to special-case them.
 */
export function isRotatedLogPath(filePath: string): boolean {
  return /\.log\.\d+$/.test(filePath);
}

/**
 * The user-level logs are pino JSONL that happen to carry a `.log` suffix, so
 * routing them by extension alone would give them the substring-only pass and
 * silently skip the per-line credential scrub.
 */
function isLineDelimitedJson(filePath: string): boolean {
  return filePath.endsWith('.jsonl') || filePath.endsWith('.log') || isRotatedLogPath(filePath);
}

export function redactStagedBundle(opts: RedactStagedBundleOpts): void {
  const ctx: RedactCtx = { contentDir: opts.contentDir };

  for (const subdir of ['telemetry', 'logs', 'process']) {
    for (const filePath of walkDirFiles(join(opts.stagingDir, subdir))) {
      if (isLineDelimitedJson(filePath)) {
        redactJsonlFile(filePath, ctx);
      } else if (filePath.endsWith('.json')) {
        redactJsonFile(filePath, ctx);
      } else {
        redactPlainFile(filePath, ctx);
      }
    }
  }

  for (const filePath of walkDirFiles(join(opts.stagingDir, 'state'))) {
    // basename, not manual slice — node:path's basename handles both POSIX and
    // Windows separators, so a backslash-joined staging path on Windows still
    // routes runtime.json to the JSON walker. Manual `lastIndexOf('/')` returns
    // -1 on backslash paths, leaving `base` as the full absolute path, which
    // misses STATE_JSON_FILES and silently falls through to the plain walker.
    const base = basename(filePath);
    if (filePath.endsWith('.jsonl')) {
      redactJsonlFile(filePath, ctx);
    } else if (STATE_JSON_FILES.has(base)) {
      redactJsonFile(filePath, ctx);
    } else {
      redactPlainFile(filePath, ctx);
    }
  }
}
