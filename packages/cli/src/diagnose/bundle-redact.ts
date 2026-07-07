/**
 * Bundle redactor. Walks the staged copies of telemetry / log / state files
 * and applies two transforms:
 *
 *   1. Doc-name hashing — values keyed by `doc.name` (OTLP attribute-pair shape
 *      `{key, value:{stringValue}}` and Pino-flat `{ "doc.name": "..." }`)
 *      become `doc:<8 hex>`, derived from BLAKE2b-256(value) truncated to
 *      8 hex chars.
 *
 *   2. Content-dir prefix substitution — the absolute content-dir path,
 *      wherever it appears as a substring of any string value, is replaced
 *      with the literal token `<CONTENT_DIR>`.
 *
 * Mutates the staged copies in place; the originals under
 * `<contentDir>/.ok/local/{telemetry,logs}/` are untouched — the collector
 * already stages copies before invoking this module.
 *
 * Stable per bundle: the same input value always hashes to the same output
 * within one invocation, and only one inverse-map entry is produced per
 * distinct input. The map is returned for the caller (collectBundle) to
 * persist into `manifest.json.redaction.docNameMap`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONTENT_DIR_TOKEN = '<CONTENT_DIR>';
const HASH_PREFIX = 'doc:';
const HASH_HEX_LEN = 8;
// Keys whose values are treated as doc-name-shaped. The OTLP attribute pair
// form sets `key` to one of these and stores the value under `value.stringValue`;
// the Pino flat form sets the key directly on the log record. Single source
// for both shapes — extending DOC_NAME_KEYS covers both at once.
const DOC_NAME_KEYS = new Set(['doc.name']);

export interface RedactStagedBundleOpts {
  /** Absolute path to the staging dir (contains telemetry/, logs/, state/). */
  stagingDir: string;
  /** Absolute content-dir path to substitute with `<CONTENT_DIR>`. */
  contentDir: string;
}

export interface RedactStagedBundleResult {
  /** Stable per-bundle inverse map: hashed → original value. */
  docNameMap: Record<string, string>;
  /**
   * Collisions detected while building `docNameMap`. Keyed by the colliding
   * hash; value is the list of *additional* originals (beyond the one stored
   * in `docNameMap`) that hashed to the same 8-hex prefix. Empty `{}` when
   * no collision occurred. With 32 bits of hash space, collisions are
   * vanishingly rare for typical workspaces (<1k doc names), but recording
   * them keeps the contract honest for very large corpora and prevents
   * silent loss of an original from the inverse map.
   */
  docNameCollisions: Record<string, string[]>;
}

interface RedactCtx {
  contentDir: string;
  docNameMap: Record<string, string>;
  originalToHashed: Map<string, string>;
  docNameCollisions: Record<string, string[]>;
}

function hashDocName(value: string): string {
  // BLAKE2b-256 via OpenSSL's blake2b512 algorithm with outputLength=32 bytes
  // — Bun + Node both honor the `outputLength` option for BLAKE2 variants,
  // producing BLAKE2b-256 truncated to 8 hex chars. 32 bits of
  // hash space is enough for the per-bundle uniqueness contract (typical
  // workspaces carry <1k doc names; collision risk negligible at this scale).
  const digest = createHash('blake2b512', { outputLength: 32 }).update(value).digest('hex');
  return `${HASH_PREFIX}${digest.slice(0, HASH_HEX_LEN)}`;
}

/**
 * Record a value under a hash in the inverse map. First value wins the
 * `docNameMap[hash]` slot; subsequent distinct values that hash to the same
 * key land in `docNameCollisions[hash]` so they're never silently lost.
 * Idempotent: repeating the same value is a no-op.
 *
 * Exported as `_recordHashForTests` for collision-path unit testing — real
 * 32-bit hash collisions are infeasible to generate as test fixtures.
 */
function recordHash(ctx: RedactCtx, value: string, hashed: string): void {
  const prev = ctx.docNameMap[hashed];
  if (prev === undefined) {
    ctx.docNameMap[hashed] = value;
    return;
  }
  if (prev === value) return;
  const existing = ctx.docNameCollisions[hashed];
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
  } else {
    ctx.docNameCollisions[hashed] = [value];
  }
}

export const _recordHashForTests = recordHash;

function hashOrLookup(value: string, ctx: RedactCtx): string {
  const cached = ctx.originalToHashed.get(value);
  if (cached !== undefined) return cached;
  const hashed = hashDocName(value);
  ctx.originalToHashed.set(value, hashed);
  recordHash(ctx, value, hashed);
  return hashed;
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
 * Recursively redact a parsed JSON node. Returns a new tree; does not mutate
 * the input. Two key transforms:
 *
 *   - OTLP attribute-pair: `{key: "doc.name", value: {stringValue: X}}`
 *     becomes `{key: "doc.name", value: {stringValue: doc:<8hex>(X)}}`. The
 *     hash short-circuits any further descent into `value.stringValue` so the
 *     prefix-substitution pass never sees the secret.
 *   - Pino flat: any property whose key is in DOC_NAME_KEYS and whose value
 *     is a string is hashed in place.
 *
 * All other strings get the content-dir substring substitution; non-string
 * leaves pass through.
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

  const otlpStringValue =
    typeof node.key === 'string' &&
    DOC_NAME_KEYS.has(node.key) &&
    isObject(node.value) &&
    typeof (node.value as Record<string, unknown>).stringValue === 'string'
      ? ((node.value as Record<string, unknown>).stringValue as string)
      : null;

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (otlpStringValue !== null && k === 'value' && isObject(v)) {
      const hashed = hashOrLookup(otlpStringValue, ctx);
      result[k] = { ...v, stringValue: hashed };
    } else if (DOC_NAME_KEYS.has(k) && typeof v === 'string') {
      result[k] = hashOrLookup(v, ctx);
    } else {
      result[k] = redactValue(v, ctx);
    }
  }
  return result;
}

/**
 * Best-effort substring scrub for content the JSON walker couldn't descend
 * into. Replaces every previously-seen doc name (as recorded in
 * `ctx.originalToHashed` by earlier-walked files) with its hashed value, so a
 * corrupt or torn JSON / JSONL fragment doesn't leak names the
 * structural walker would have masked. The pipeline always walks
 * `telemetry`/`logs`/`process` before `state`, so by the time a state file's
 * unparseable fallback runs the map is populated for any doc that appeared in
 * a structured record.
 *
 * Iteration order is longest-first to avoid shadow-mask races when one doc
 * name is a substring of another (e.g. `notes/foo` vs `notes/foo-bar`):
 * substituting `notes/foo` first would mutate the longer literal mid-scan.
 */
function substringScrubDocNames(content: string, ctx: RedactCtx): string {
  if (ctx.originalToHashed.size === 0) return content;
  const ordered = Array.from(ctx.originalToHashed.entries()).sort(
    ([a], [b]) => b.length - a.length,
  );
  let out = content;
  for (const [original, hashed] of ordered) {
    if (original.length === 0) continue;
    if (!out.includes(original)) continue;
    out = out.split(original).join(hashed);
  }
  return out;
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
    // Whole-file JSON parse failure (truncated write, manual edit, etc.):
    // fall back to substring scrubs so a corrupt state file still has the
    // content-dir prefix substituted and any doc name already collected by
    // the structural walker masked. Without this, an `agent-presence.json`
    // torn mid-write would leak doc names the --redact flag promised to
    // hide.
    const contentDirReplaced = replaceContentDir(content, ctx.contentDir);
    const docNameScrubbed = substringScrubDocNames(contentDirReplaced, ctx);
    if (docNameScrubbed !== content) writeFileSync(filePath, docNameScrubbed);
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
    // Dir doesn't exist (nothing staged for that subdir) — nothing to redact.
    return [];
  }
}

// State files that are JSON-shaped get a full walker pass (agent-presence may
// carry per-agent doc.name fields; runtime.json may carry the contentDir).
// Other state files get substring-only substitution.
const STATE_JSON_FILES = new Set(['agent-presence.json', 'runtime.json']);

export function redactStagedBundle(opts: RedactStagedBundleOpts): RedactStagedBundleResult {
  const ctx: RedactCtx = {
    contentDir: opts.contentDir,
    docNameMap: {},
    originalToHashed: new Map(),
    docNameCollisions: {},
  };

  for (const subdir of ['telemetry', 'logs', 'process']) {
    for (const filePath of walkDirFiles(join(opts.stagingDir, subdir))) {
      if (filePath.endsWith('.jsonl')) {
        redactJsonlFile(filePath, ctx);
      } else if (filePath.endsWith('.json')) {
        redactJsonFile(filePath, ctx);
      } else {
        redactPlainFile(filePath, ctx);
      }
    }
  }

  for (const filePath of walkDirFiles(join(opts.stagingDir, 'state'))) {
    // basename, not manual slice — node:path's basename handles both POSIX
    // and Windows separators, so a backslash-joined staging path on Windows
    // still routes agent-presence.json / runtime.json to the doc-name-
    // hashing JSON walker. Manual `lastIndexOf('/')` returns -1 on
    // backslash paths, leaving `base` as the full absolute path, which
    // misses the STATE_JSON_FILES set and silently falls through to the
    // substring-only walker.
    const base = basename(filePath);
    if (STATE_JSON_FILES.has(base)) {
      redactJsonFile(filePath, ctx);
    } else {
      redactPlainFile(filePath, ctx);
    }
  }

  return { docNameMap: ctx.docNameMap, docNameCollisions: ctx.docNameCollisions };
}
