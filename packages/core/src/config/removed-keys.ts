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
 * Every entry here is rejected loudly with a source-located `REMOVED_KEY`
 * error whose `redirect` names the replacement. The same table drives the
 * `ok config migrate` codemod, so the "run `ok config migrate`" hint in each
 * redirect is always truthful.
 *
 * Severity is uniform — there is no warn tier. Where the error surfaces
 * (throw vs. sideline) is the CALLER's decision: the project loader throws
 * (fail-fast, the key is user-fixable in place), while the cold-start
 * recovery path (`readConfigSafely`, used for `~/.ok/global.yml`) sidelines
 * the file and boots on defaults so a stale user-global config can never
 * brick every project.
 */
import type { Document } from 'yaml';
import type { ConfigIssueSource, ConfigValidationError } from './errors.ts';
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
const MIGRATE_HINT =
  'Run `ok config migrate` to strip the obsolete key from config.yml automatically, or remove it by hand.';

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
    redirect: [
      'Use the --host CLI flag or the HOST environment variable instead.',
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
    // The "Show all files" sidebar toggle was removed; the tree now always
    // lists every file on disk. Top-level config is loose, so a residual
    // `appearance.sidebar.showAllFiles: false` would otherwise be a silent
    // no-op for users who had scoped their tree to indexed/linked content.
    path: ['appearance', 'sidebar', 'showAllFiles'],
    redirect: [
      'appearance.sidebar.showAllFiles has been removed.',
      'The sidebar now always lists every file on disk; dot-prefixed entries are still gated by appearance.sidebar.showHiddenFiles. There is no longer a way to scope the tree to indexed/linked content.',
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
export function detectRemovedKeys(input: DetectRemovedKeysInput): ConfigValidationError[] {
  const { value, file, source, doc } = input;
  if (!isPlainObject(value)) return [];
  const errors: ConfigValidationError[] = [];
  for (const entry of REMOVED_KEYS) {
    if (!hasLeaf(value, entry.path)) continue;
    let located: ConfigIssueSource | undefined;
    if (doc != null && source != null && file != null) {
      located = locateIssue({ file, source, doc, path: entry.path });
    }
    errors.push({
      code: 'REMOVED_KEY',
      path: entry.path,
      redirect: entry.redirect,
      ...(located !== undefined ? { source: located } : {}),
    });
  }
  return errors;
}
