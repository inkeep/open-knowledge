import type { Document } from 'yaml';
import { currentCliCommandName } from '../constants/product.ts';
import type { ConfigIssueSource, RemovedKeyDiagnostic } from './errors.ts';
import { locateIssue } from './source-locator.ts';

export interface RemovedKey {
  path: string[];
  readonly redirect: string;
}

const migrateHint = (): string =>
  `Run \`${currentCliCommandName()} config migrate\` to strip the obsolete key automatically, or remove it by hand.`;

export const REMOVED_KEYS: readonly RemovedKey[] = [
  {
    path: ['content', 'include'],
    get redirect() {
      return [
        'content.include has been removed.',
        'For subdirectory scoping, set content.dir in .ok/config.yml instead.',
        'For pattern-based filtering, use .okignore (gitignore syntax — exclude-only; do not copy include patterns directly).',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['content', 'exclude'],
    get redirect() {
      return [
        'Move these patterns to .okignore at the project root (gitignore syntax, 1:1 migration).',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['folders'],
    get redirect() {
      return [
        'folders is no longer a top-level config field.',
        "A folder's own frontmatter (open-shape, like a doc's) lives in nested `<folder>/.ok/frontmatter.yml`; new-doc starting properties come from templates in `<folder>/.ok/templates/`.",
        'Edit via the folder overview in the editor sidebar, or `edit({ folder: { path, frontmatter } })` via the MCP.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['appearance', 'editorModeDefault'],
    get redirect() {
      return [
        'appearance.editorModeDefault was removed and is never read — new docs always open in WYSIWYG; toggle mode via the editor mode button.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['upload', 'maxBytes'],
    get redirect() {
      return [
        'streaming uploads have no user-facing cap; the value is hardcoded in @inkeep/open-knowledge-core.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['github', 'oauthAppClientId'],
    get redirect() {
      return [
        'Use the OPEN_KNOWLEDGE_GITHUB_CLIENT_ID environment variable instead.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['server', 'host'],
    get redirect() {
      return [
        'Use server.bind in .ok/config.yml instead — a list of bind addresses, e.g. [127.0.0.1]; a non-loopback bind additionally requires server.allowExternal.',
        'The --bind CLI flag and HOST environment variable also remain available.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['remote', 'url'],
    get redirect() {
      return [
        'remote.url has been removed. Use server.externalUrl in .ok/config.yml instead (the public origin your tunnel serves).',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['remote', 'port'],
    get redirect() {
      return [
        'remote.port has been removed. Use server.port in .ok/config.yml instead.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['server', 'publicUrl'],
    get redirect() {
      return [
        'server.publicUrl has been removed. Use server.externalUrl in .ok/config.yml instead (the same key under its current name).',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['server', 'openOnAgentEdit'],
    get redirect() {
      return ['This behavior was removed; the value is hardcoded.', migrateHint()].join(' ');
    },
  },
  {
    path: ['mcp', 'autoStart'],
    get redirect() {
      return ['To disable MCP auto-start, set OK_MCP_AUTOSTART=0.', migrateHint()].join(' ');
    },
  },
  {
    path: ['mcp', 'tools', 'read_document', 'historyDepth'],
    get redirect() {
      return ['This value is hardcoded in @inkeep/open-knowledge-core.', migrateHint()].join(' ');
    },
  },
  {
    path: ['mcp', 'tools', 'grep', 'maxResults'],
    get redirect() {
      return ['This value is hardcoded in @inkeep/open-knowledge-core.', migrateHint()].join(' ');
    },
  },
  {
    path: ['mcp', 'tools', 'search', 'maxResults'],
    get redirect() {
      return [
        'The search result cap is hardcoded in @inkeep/open-knowledge-core; this config key was removed.',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['preview', 'baseUrl'],
    get redirect() {
      return [
        `preview URLs now resolve only to the running server — start one with \`${currentCliCommandName()} start\`.`,
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['preview', 'scriptSrc'],
    get redirect() {
      return [
        'preview.scriptSrc has been removed.',
        'The code-block preview iframe now runs a fixed open network policy (it is no longer configurable).',
        migrateHint(),
      ].join(' ');
    },
  },
  {
    path: ['appearance', 'sidebar', 'showAllFiles'],
    get redirect() {
      return [
        'appearance.sidebar.showAllFiles has been removed.',
        'The sidebar lists every file on disk by default; dot-prefixed entries are gated by appearance.sidebar.showHiddenFiles, and appearance.sidebar.showOnlyMarkdownFiles scopes the tree down to markdown documents as a per-machine view preference.',
        migrateHint(),
      ].join(' ');
    },
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  value: unknown;
  file?: string | null;
  source?: string | null;
  doc?: Document | null;
}

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
