/**
 * Single source of truth for config keys that have been removed from the
 * schema and are no longer read by the engine.
 *
 * OpenKnowledge config is loose at every layer (`ConfigSchema` is a
 * `looseObject`; the published JSON schema is open), so a stale key neither
 * fails Zod validation nor autocompletes-as-invalid. Without an explicit
 * registry a removed key is a silent no-op — the worst failure mode for a
 * config contract, because the user believes it took effect.
 *
 * Readers strip every entry here from the parsed value and surface a
 * source-located `REMOVED_KEY` diagnostic whose `redirect` names the
 * replacement. Stripping a removed key can never change runtime behavior — by
 * contract the engine no longer reads it — so a dead key never invalidates its
 * live siblings. The same table drives the `ok config migrate` codemod, and
 * that command defaults to every config layer, so the bare "run `ok config
 * migrate`" hint in each redirect reaches the key it names wherever it lives —
 * including the project-local layer. Narrowing that default would make the
 * hint false for any key outside the layers it still covers.
 *
 * Severity is uniform — there is no warn tier. The registry records only the
 * fact of the mismatch; whether a given caller warns, blocks, or degrades a
 * dependent feature is caller policy, not a property of the entry.
 */
import type { Document } from 'yaml';
import type { ConfigIssueSource, RemovedKeyDiagnostic } from './errors.ts';
import { locateIssue } from './source-locator.ts';

export interface RemovedKey {
  /** Dotted-path segments, e.g. `['content', 'include']` or `['folders']`. */
  path: string[];
  /** Migration directive naming the replacement. Rendered by `humanFormat`. */
  redirect: string;
}

/**
 * Shared tail appended to every redirect except the bespoke `content.*` ones
 * (those predate the registry and carry their own, test-pinned wording).
 */
// Names no file on purpose. A removed key can sit in any of three layers
// (`~/.ok/global.yml`, `.ok/config.yml`, `.ok/local/config.yml`) and the command
// defaults to all of them, so naming `config.yml` would read as a limit the
// command does not have.
const MIGRATE_HINT =
  'Run `ok config migrate` to strip the obsolete key automatically, or remove it by hand.';

/**
 * The removed-key registry. Adding a removal is a one-line entry here — the
 * detector, the loader rejection, the cold-start sideline, and the migrate
 * codemod all read from this table.
 */
export const REMOVED_KEYS: readonly RemovedKey[] = [
  {
    path: ['content', 'include'],
    // Bespoke wording (no shared hint) — `content.include` was a positive
    // whitelist, so copying its patterns straight into exclude-only
    // `.okignore` would invert intent. Surface `content.dir` as the simpler
    // subdirectory-scoping alternative for the common include case.
    redirect: [
      'content.include has been removed.',
      'For subdirectory scoping, set content.dir in .ok/config.yml instead.',
      'For pattern-based filtering, use .okignore (gitignore syntax — exclude-only; do not copy include patterns directly).',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['content', 'exclude'],
    redirect: [
      'Move these patterns to .okignore at the project root (gitignore syntax, 1:1 migration).',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['folders'],
    redirect: [
      'folders is no longer a top-level config field.',
      "A folder's own frontmatter (open-shape, like a doc's) lives in nested `<folder>/.ok/frontmatter.yml`; new-doc starting properties come from templates in `<folder>/.ok/templates/`.",
      'Edit via the folder overview in the editor sidebar, or `edit({ folder: { path, frontmatter } })` via the MCP.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['appearance', 'editorModeDefault'],
    redirect: [
      'appearance.editorModeDefault was removed and is never read — new docs always open in WYSIWYG; toggle mode via the editor mode button.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['upload', 'maxBytes'],
    redirect: [
      'streaming uploads have no user-facing cap; the value is hardcoded in @inkeep/open-knowledge-core.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['github', 'oauthAppClientId'],
    redirect: [
      'Use the OPEN_KNOWLEDGE_GITHUB_CLIENT_ID environment variable instead.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['server', 'host'],
    // Rewritten when `server.bind` returned as a live config key — the old
    // "use --host / HOST" text pointed away from the file at the exact moment
    // a file key existed again.
    redirect: [
      'Use server.bind in .ok/config.yml instead — a list of bind addresses, e.g. [127.0.0.1]; a non-loopback bind additionally requires server.allowExternal.',
      'The --host CLI flag and HOST environment variable also remain available.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['server', 'openOnAgentEdit'],
    redirect: ['This behavior was removed; the value is hardcoded.', MIGRATE_HINT].join(' '),
  },
  {
    path: ['mcp', 'autoStart'],
    redirect: ['To disable MCP auto-start, set OK_MCP_AUTOSTART=0.', MIGRATE_HINT].join(' '),
  },
  {
    path: ['mcp', 'tools', 'read_document', 'historyDepth'],
    redirect: ['This value is hardcoded in @inkeep/open-knowledge-core.', MIGRATE_HINT].join(' '),
  },
  {
    path: ['mcp', 'tools', 'grep', 'maxResults'],
    redirect: ['This value is hardcoded in @inkeep/open-knowledge-core.', MIGRATE_HINT].join(' '),
  },
  {
    // Older name of this result-cap config key; configs untouched since the
    // key was renamed still carry it. Flag it so users get a signal
    // regardless of which name their config used.
    path: ['mcp', 'tools', 'search', 'maxResults'],
    redirect: [
      'The search result cap is hardcoded in @inkeep/open-knowledge-core; this config key was removed.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    path: ['preview', 'baseUrl'],
    redirect: [
      'preview URLs now resolve only to the running UI process — start one with `ok ui`.',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    // Removed: the code-block preview iframe now runs a fixed open network CSP
    // and is no longer configurable. Flag it loudly — top-level config is loose,
    // so a stale `preview.scriptSrc` would otherwise be a silent no-op.
    path: ['preview', 'scriptSrc'],
    redirect: [
      'preview.scriptSrc has been removed.',
      'The code-block preview iframe now runs a fixed open network policy (it is no longer configurable).',
      MIGRATE_HINT,
    ].join(' '),
  },
  {
    // The "Show all files" sidebar toggle was removed; the tree lists every
    // file on disk by default. Top-level config is loose, so a residual
    // `appearance.sidebar.showAllFiles: false` would otherwise be a silent
    // no-op for users who had scoped their tree to indexed/linked content.
    path: ['appearance', 'sidebar', 'showAllFiles'],
    redirect: [
      'appearance.sidebar.showAllFiles has been removed.',
      'The sidebar lists every file on disk by default; dot-prefixed entries are gated by appearance.sidebar.showHiddenFiles, and appearance.sidebar.showOnlyMarkdownFiles scopes the tree down to markdown documents as a per-machine view preference.',
      MIGRATE_HINT,
    ].join(' '),
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` has the (possibly nested) leaf at `path` set to anything. */
function hasLeaf(value: unknown, path: readonly string[]): boolean {
  let cursor: unknown = value;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cursor)) return false;
    cursor = cursor[path[i] as string];
  }
  if (!isPlainObject(cursor)) return false;
  return (path[path.length - 1] as string) in cursor;
}

export interface DetectRemovedKeysInput {
  /** Parsed config object (the raw YAML projection — pre-merge, pre-schema). */
  value: unknown;
  /** Absolute file path, for source-located errors. Omit for value-only mode. */
  file?: string | null;
  /** Raw file source, for source-located errors. */
  source?: string | null;
  /** yaml@2 Document AST, for source-located errors. */
  doc?: Document | null;
}

/**
 * Walk a parsed config against `REMOVED_KEYS` and return one `REMOVED_KEY`
 * error per match. A config carrying several dead keys yields all of them in
 * one pass — no two-trip fix cycle. Each error is source-located when `file`,
 * `source`, and `doc` are supplied.
 */
export function detectRemovedKeys(input: DetectRemovedKeysInput): RemovedKeyDiagnostic[] {
  const { value, file, source, doc } = input;
  if (!isPlainObject(value)) return [];
  const diagnostics: RemovedKeyDiagnostic[] = [];
  for (const entry of REMOVED_KEYS) {
    if (!hasLeaf(value, entry.path)) continue;
    let located: ConfigIssueSource | undefined;
    if (doc != null && source != null && file != null) {
      located = locateIssue({ file, source, doc, path: entry.path });
    }
    diagnostics.push({
      code: 'REMOVED_KEY',
      path: entry.path,
      redirect: entry.redirect,
      ...(located !== undefined ? { source: located } : {}),
    });
  }
  return diagnostics;
}

/**
 * Remove `path`'s leaf from `obj`, cloning only the objects along the path so
 * untouched subtrees are shared by reference. Returns a new object; `obj` is
 * never mutated.
 */
function removePath(
  obj: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  const clone: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    delete clone[head];
    return clone;
  }
  const child = clone[head];
  if (isPlainObject(child)) {
    clone[head] = removePath(child, rest);
  }
  return clone;
}

/**
 * Return `value` with every registry key removed. Non-object input is returned
 * unchanged; the input is never mutated. Callers strip the dead keys from the
 * parsed config, then re-validate so schema defaults re-apply cleanly to the
 * cleaned object.
 *
 * Stripping keys from an object yields an object, so the object overload lets
 * a caller that passes a typed record use the result without re-narrowing.
 */
export function stripRemovedKeys(value: Record<string, unknown>): Record<string, unknown>;
export function stripRemovedKeys(value: unknown): unknown;
export function stripRemovedKeys(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  let result: Record<string, unknown> = value;
  for (const entry of REMOVED_KEYS) {
    if (!hasLeaf(result, entry.path)) continue;
    result = removePath(result, entry.path);
  }
  return result;
}
