/**
 * Follow-the-file: derive which document the agent is currently working on
 * from a thread's tool calls, so the editor can navigate along while the
 * agent creates and edits files (the ACP `locations` contract, plus the
 * OpenKnowledge MCP tools' argument shapes).
 *
 * Two signal shapes, in priority order:
 *   1. OK MCP tool calls — adapters report them with
 *      `rawInput: { server, tool, arguments: {…} }` (Codex), with `arguments`
 *      as a JSON string (adapter-dependent), or as the arguments object
 *      directly. The doc target is wherever the verb vocabulary puts it:
 *      `document.path` (write / edit), flat `to` (move), flat `docName`
 *      (links / history), or a `.md`/`.mdx` path referenced inside an `exec`
 *      / shell `command` string.
 *   2. `locations[]` — absolute file paths (native read/edit tools). Mapped to
 *      a docName by stripping the workspace `contentDir` prefix and the
 *      `.md`/`.mdx` extension; non-markdown paths are not editor documents and
 *      resolve to null.
 */

import type { RenderedToolCall } from '@/lib/acp/thread-event-model';
import type { Workspace } from '@/lib/workspace-paths';

const FOLLOW_PREF_KEY = 'ok-acp-follow-file-v1';

/** Persisted follow toggle; defaults ON (the launch-demo behavior). */
export function loadFollowFilePref(): boolean {
  try {
    return localStorage.getItem(FOLLOW_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveFollowFilePref(enabled: boolean): void {
  try {
    localStorage.setItem(FOLLOW_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // Privacy mode / no storage — the in-session toggle still works.
  }
}

/**
 * A docName is only navigable when it is a plain relative identifier.
 * Dot-segment docs (`.codex/skills/…`, `.ok/…`) are agent/config plumbing,
 * not user content — following them would open the transcript with a jump to
 * the agent's own skill file instead of the user's documents.
 */
export function sanitizeDocName(docName: string): string | null {
  if (docName === '' || docName.startsWith('/') || docName.startsWith('\\')) return null;
  const segments = docName.split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null;
  return docName;
}

/** Map an absolute file path to a docName relative to `contentDir`. */
export function docNameFromAbsolutePath(path: string, workspace: Workspace): string | null {
  const sep = workspace.pathSeparator;
  const normalize = (p: string): string => (sep === '\\' ? p.replaceAll('\\', '/') : p);
  const root = normalize(workspace.contentDir).replace(/\/$/, '');
  const normalized = normalize(path);
  if (!normalized.startsWith(`${root}/`)) return null;
  const relative = normalized.slice(root.length + 1);
  const match = /\.(md|mdx)$/.exec(relative);
  if (match === null) return null;
  return sanitizeDocName(relative.slice(0, -match[0].length));
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read-only command heads worth following (mirrors the OK `exec` tool's
 * allowlist, plus common read-only lookalikes). A command whose head is not
 * listed — `rm`, `mv`, arbitrary scripts — never drives navigation: following
 * a file that a command is deleting or renaming is not what follow means.
 */
const FOLLOWABLE_COMMAND_HEADS = new Set([
  'cat',
  'ls',
  'grep',
  'rg',
  'find',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'sed',
  'awk',
  'bat',
  'less',
  'more',
]);

/**
 * DocName referenced by a shell-ish `command` string (the OK `exec` tool, or
 * a native terminal tool). First `.md`/`.mdx` token wins — the primary
 * operand. Globs carry no single target; flags are skipped; absolute paths
 * map through the workspace root like `locations[]` entries do.
 */
function docTargetFromCommand(command: string, workspace: Workspace | null): string | null {
  const tokens: string[] = [];
  const tokenizer = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = tokenizer.exec(command);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = tokenizer.exec(command);
  }
  const head = tokens[0];
  if (head === undefined || !FOLLOWABLE_COMMAND_HEADS.has(head)) return null;
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) continue;
    if (/[*?[\]]/.test(token)) continue;
    const mdMatch = /\.(md|mdx)$/i.exec(token);
    if (mdMatch === null) continue;
    if (token.startsWith('/') || /^[A-Za-z]:[\\/]/.test(token)) {
      if (workspace !== null) {
        const doc = docNameFromAbsolutePath(token, workspace);
        if (doc !== null) return doc;
      }
      continue;
    }
    const doc = sanitizeDocName(token.replace(/^\.\//, '').slice(0, -mdMatch[0].length));
    if (doc !== null) return doc;
  }
  return null;
}

/**
 * Follow-target options. `docExists` gates READ-shaped targets on the doc
 * actually existing: a read of a missing file must not navigate — the editor
 * would open a blank create-on-open tab. Two read-shaped sources are gated:
 * the `exec`/shell `command` string path (`cat log.md` on a doc that was never
 * created, which parked the editor on an empty "log" page), and the
 * `locations[]` path of non-`edit` tool calls (a native read/search/exec whose
 * newest location names a doc that never existed, which opened a blank "main"
 * page). Write-shaped targets (`document`/`documents`/`to`/`docName`, and
 * `edit`/`move` locations) are deliberately NOT gated: they routinely name
 * docs that don't exist YET (the write creates them). When the predicate is
 * absent (the page list is still loading, or its fetch failed and we can't
 * distinguish missing from unknown) targets pass through ungated — unknown is
 * not the same as missing.
 */
export interface FollowTargetOptions {
  docExists?: (docName: string) => boolean;
}

/**
 * Structural subset of `PageListContextValue` this module reads. Kept narrow
 * on purpose — the follow-file layer never touches the wider PageList API
 * (slug indexes, folder paths, refetch), so accepting only what it consumes
 * keeps the ThreadView call site substitutable without wiring the full
 * context shape through.
 */
export interface PageListPredicateInput {
  readonly loading: boolean;
  readonly error: string | null;
  readonly pages: ReadonlySet<string>;
}

/**
 * Derive the follow-file predicate options from a page-list snapshot. The
 * predicate is only armed when the snapshot is authoritative: the cold
 * fetch has resolved (`!loading`) AND it did NOT error (`error === null`).
 * A failed fetch may leave `pages` empty (cold-load failure) or stale
 * (background refetch failure keeps the last-good set — see
 * `PageListContext`); in either case the set is not authoritative and
 * treating it as such would mask every doc as missing (cold) or
 * misclassify a just-created doc as missing (stale) and silently disable
 * all read-shaped follow until the next successful refetch — unknown is
 * not the same as missing.
 * Optional variant: the dock renders in hosts/tests without the provider,
 * so `null` degrades to an empty options object (predicate absent →
 * ungated, previous behavior).
 */
export function pageListFollowOptions(
  pageList: PageListPredicateInput | null,
): FollowTargetOptions {
  if (pageList === null || pageList.loading || pageList.error !== null) return {};
  const pages = pageList.pages;
  return { docExists: (docName: string) => pages.has(docName) };
}

/**
 * Unwrap an OK MCP call's rawInput into `{ tool, args }`. Codex reports
 * `{ server, tool, arguments }`; other adapters name the tool at `name`, pass
 * `arguments` as a serialized JSON string, or pass the arguments object bare
 * with no tool name at all.
 */
function unwrapMcpInput(
  rawInput: unknown,
): { tool: string | null; args: Record<string, unknown> } | null {
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const input = rawInput as Record<string, unknown>;
  const tool = stringField(input, 'tool') ?? stringField(input, 'name');
  let args: Record<string, unknown> = input;
  if (typeof input.arguments === 'object' && input.arguments !== null) {
    args = input.arguments as Record<string, unknown>;
  } else if (typeof input.arguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(input.arguments);
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — treat the input itself as the args object.
    }
  }
  return { tool, args };
}

/**
 * DocName from an OK MCP tool call's rawInput, or null when the call is not
 * an OK MCP doc operation. Deletions return null — navigating to a document
 * that is being removed is never what follow mode means.
 */
function mcpDocTarget(
  rawInput: unknown,
  title: string,
  workspace: Workspace | null,
  options: FollowTargetOptions,
): string | null {
  const unwrapped = unwrapMcpInput(rawInput);
  if (unwrapped === null) return null;
  const { tool, args } = unwrapped;
  // Deletion guard: by tool name when the adapter reports one, by the call
  // title otherwise (the bare-arguments shape of `delete` is otherwise
  // indistinguishable from `write`'s).
  if (tool === 'delete' || (tool === null && /\bdelete\b/i.test(title))) return null;
  // The OK MCP write/edit schema nests the target at `document.path`
  // (observed from real Codex tool_call rawInput); batch writes carry
  // `documents: [...]` instead — the LAST entry is the most recent write, so
  // that's the one to follow (observed live: a 12-page batch produced no
  // follow target at all before this branch existed); `move` lands the doc at
  // flat `to` (template/skill moves nest theirs — those are not documents);
  // `docName` is the flat fallback shape.
  const document =
    typeof args.document === 'object' && args.document !== null
      ? (args.document as Record<string, unknown>)
      : null;
  let lastBatchEntry: Record<string, unknown> | null = null;
  if (Array.isArray(args.documents)) {
    for (let i = args.documents.length - 1; i >= 0; i--) {
      const entry: unknown = args.documents[i];
      if (typeof entry === 'object' && entry !== null) {
        lastBatchEntry = entry as Record<string, unknown>;
        break;
      }
    }
  }
  const docName =
    (document !== null ? stringField(document, 'path') : null) ??
    (lastBatchEntry !== null ? stringField(lastBatchEntry, 'path') : null) ??
    stringField(args, 'to') ??
    stringField(args, 'docName');
  if (docName !== null) {
    // Agents sometimes pass the on-disk form (`orbit/plan.md`); the navigable
    // docName is extension-less.
    return sanitizeDocName(docName.replace(/\.(md|mdx)$/, ''));
  }
  const command = stringField(args, 'command');
  if (command !== null) {
    const target = docTargetFromCommand(command, workspace);
    if (target !== null && options.docExists !== undefined && !options.docExists(target)) {
      return null;
    }
    return target;
  }
  return null;
}

/**
 * The document a tool call is working on, or null when it has none (shell
 * commands, searches, deletions, files outside the workspace).
 */
export function followTargetFromToolCall(
  call: Pick<RenderedToolCall, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  workspace: Workspace | null,
  options: FollowTargetOptions = {},
): string | null {
  if (call.toolKind === 'delete') return null;
  const mcp = mcpDocTarget(call.rawInput, call.title, workspace, options);
  if (mcp !== null) return mcp;
  if (workspace === null) return null;
  // A location-derived target from a non-write-shaped call (read/search/exec/…)
  // only navigates to a doc that exists — the newest location of such a call
  // can name a file that was never created (a git branch name, a phantom path
  // from the prompt), which would otherwise open a blank create-on-open tab.
  // `edit` is the create case (it names the doc it is about to write) and
  // `move` is the rename case (its newest location IS the destination — by
  // definition not in the page list yet); both stay ungated, matching the
  // write-shaped MCP targets above (`document.path` for edit, flat `to` for
  // move). Every other ACP toolKind is treated as read-shaped and gated.
  const gateMissingLocation =
    call.toolKind !== 'edit' && call.toolKind !== 'move' && options.docExists !== undefined;
  // Newest location wins — long calls append locations as they progress.
  for (let i = call.locations.length - 1; i >= 0; i--) {
    const location = call.locations[i];
    if (location === undefined) continue;
    const docName = docNameFromAbsolutePath(location.path, workspace);
    if (docName === null) continue;
    if (gateMissingLocation && !options.docExists?.(docName)) return null;
    return docName;
  }
  return null;
}

/**
 * The latest followable document across a transcript's items (last tool call
 * with a resolvable target wins — that is what the agent touched most
 * recently).
 */
export function latestFollowTarget(
  items: ReadonlyArray<{ kind: string }>,
  workspace: Workspace | null,
  options: FollowTargetOptions = {},
): string | null {
  let target: string | null = null;
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const resolved = followTargetFromToolCall(item as RenderedToolCall, workspace, options);
    if (resolved !== null) target = resolved;
  }
  return target;
}
