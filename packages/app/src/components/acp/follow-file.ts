/**
 * Follow-the-file: derive which document the agent is currently working on
 * from a thread's tool calls, so the editor can navigate along while the
 * agent creates and edits files (the ACP `locations` contract, plus the
 * OpenKnowledge MCP tools' argument shapes).
 *
 * Two signal shapes, in priority order:
 *   1. OK MCP write-shaped tool calls — adapters report them with
 *      `rawInput: { server, tool, arguments: {…} }` (Codex), with `arguments`
 *      as a JSON string (adapter-dependent), or as the arguments object
 *      directly. The doc target is wherever the verb vocabulary puts it:
 *      `document.path` (write / edit), flat `to` (move), or the flat
 *      `docName` fallback shape.
 *   2. `locations[]` — absolute file paths from `edit` / `move` tool calls
 *      (native writes / renames). Mapped to a docName by stripping the
 *      workspace `contentDir` prefix and the `.md`/`.mdx` extension;
 *      non-markdown paths are not editor documents and resolve to null.
 *
 * Read-shaped calls (`exec`, `search`, `read`, other) NEVER drive follow:
 * only the user's own gestures move the active workspace tab.
 */

import { OPEN_KNOWLEDGE_MCP_WRITE_TOOLS } from '@inkeep/open-knowledge-core';
import { stringField, unwrapMcpInput } from '@/lib/acp/mcp-input';
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

const OK_MCP_WRITE_TOOLS: ReadonlySet<string> = new Set(OPEN_KNOWLEDGE_MCP_WRITE_TOOLS);

/**
 * DocName from an OK MCP tool call's rawInput, or null when the call is not
 * an OK MCP doc operation. Deletions return null — navigating to a document
 * that is being removed is never what follow mode means.
 */
function mcpDocTarget(
  rawInput: unknown,
  title: string,
  toolKind: RenderedToolCall['toolKind'],
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
  // flat `to` (template/skill moves nest theirs — those are not documents).
  // These three shapes are structurally write-only in the OK MCP schema, so
  // they are trusted at any toolKind / tool-name pair — including
  // `toolKind: 'execute'` writes the Codex adapter reports.
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
  const structural =
    (document !== null ? stringField(document, 'path') : null) ??
    (lastBatchEntry !== null ? stringField(lastBatchEntry, 'path') : null) ??
    stringField(args, 'to');
  if (structural !== null) {
    // Agents sometimes pass the on-disk form (`orbit/plan.md`); the navigable
    // docName is extension-less.
    return sanitizeDocName(structural.replace(/\.(md|mdx)$/, ''));
  }
  // Flat `docName` is a defensive fallback — the OK MCP wire schemas for
  // reads use `document` / `name` / `file`, not `docName`, so this branch is
  // unreachable for a current OK MCP read. It exists for adapter drift: a
  // bare-arg or renamed shape could put `docName` on a read tomorrow, and
  // the same gate that lets flat write shapes through must not silently let
  // that through. Follow only when the call is provably a write: either the
  // tool name is in the write allowlist, or the ACP `toolKind` is a write
  // kind (`edit` / `move`).
  const flat = stringField(args, 'docName');
  if (flat === null) return null;
  const isKnownWrite = tool !== null && OK_MCP_WRITE_TOOLS.has(tool);
  const isWriteToolKind = toolKind === 'edit' || toolKind === 'move';
  if (!isKnownWrite && !isWriteToolKind) return null;
  return sanitizeDocName(flat.replace(/\.(md|mdx)$/, ''));
}

/**
 * The document a tool call is working on, or null when it has none (shell
 * commands, searches, deletions, files outside the workspace).
 */
export function followTargetFromToolCall(
  call: Pick<RenderedToolCall, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  workspace: Workspace | null,
): string | null {
  if (call.toolKind === 'delete') return null;
  const mcp = mcpDocTarget(call.rawInput, call.title, call.toolKind);
  if (mcp !== null) return mcp;
  if (workspace === null) return null;
  // Only WRITE-shaped tool kinds drive follow from their `locations[]`:
  // `edit` is the create case, `move` is the rename case, both naming the
  // destination the agent is producing. Every other ACP toolKind — `read`,
  // `search`, `execute`, `other` — is the agent exploring, and
  // agent reads never mutate the active tab.
  if (call.toolKind !== 'edit' && call.toolKind !== 'move') return null;
  // Newest location wins — long calls append locations as they progress.
  for (let i = call.locations.length - 1; i >= 0; i--) {
    const location = call.locations[i];
    if (location === undefined) continue;
    const docName = docNameFromAbsolutePath(location.path, workspace);
    if (docName === null) continue;
    return docName;
  }
  return null;
}

/**
 * Follow-navigation state carried across a single agent turn.
 *
 * `lastFollowed` is the doc follow last drove the editor to (null until it has
 * navigated at all). `yielded` latches once the user steps OFF that track —
 * navigates the editor to a doc follow did not choose — after which follow
 * stops driving navigation for the rest of the turn, so reading another page
 * while an agent works elsewhere is never interrupted.
 */
export interface FollowNavState {
  readonly lastFollowed: string | null;
  readonly yielded: boolean;
  /**
   * A new turn just started; the NEXT off-track navigation is allowed
   * through so the user's new intent ("send this message, track the
   * work") beats the previous turn's yield latch. Cleared on the first
   * real navigate.
   *
   * `lastFollowed` is preserved across turns — a stale `followTarget`
   * left over from the previous turn deduplicates via
   * `lastFollowed === followTarget` before the reArmed bypass fires. That
   * dedupe is what keeps the re-arm from yanking the user to yesterday's
   * work the instant they press send, on no new agent activity.
   *
   * Required (rather than optional) so the false vs undefined distinction
   * disappears — a reader never has to wonder whether an absent field
   * means "not re-armed" or "we forgot to set it".
   */
  readonly reArmed: boolean;
}

export const INITIAL_FOLLOW_NAV_STATE: FollowNavState = {
  lastFollowed: null,
  yielded: false,
  reArmed: false,
};

/**
 * Decide whether follow should drive the editor to `followTarget`, given where
 * the editor currently is (`currentDoc`, the docName parsed from the location
 * hash) and the state carried from the previous decision. Pure: returns the
 * next state plus the docName to navigate to, or null to stay put.
 *
 * The yield rule is the fix for follow yanking a reader off their page: once
 * the user navigates the editor to a doc that is neither where follow last put
 * them nor where follow wants them next, they have taken manual control, so
 * follow latches off until it is re-armed (a new turn, or the follow toggle).
 * The first navigation of a turn (`lastFollowed === null`) is never treated as
 * off-track — that is follow catching up to the agent, not the user leaving.
 */
export function decideFollowNavigation(
  followTarget: string | null,
  currentDoc: string | null,
  state: FollowNavState,
): { navigateTo: string | null; state: FollowNavState } {
  if (followTarget === null) return { navigateTo: null, state };
  // Already followed this exact target — nothing new to do. Preserved before
  // the yield/off-track check so a stale target left over from the previous
  // turn (followTarget is derived from the accumulated event log and only
  // resets on log shrink) doesn't yank the user to yesterday's work the
  // instant they start a new turn. Leaves `reArmed` intact so a subsequent
  // FRESH target this turn still gets the bypass.
  if (state.lastFollowed === followTarget) return { navigateTo: null, state };
  const offTrack =
    state.lastFollowed !== null &&
    currentDoc !== null &&
    currentDoc !== state.lastFollowed &&
    currentDoc !== followTarget;
  // A re-armed turn bypasses off-track for one fresh navigation — the user
  // just directed the agent with a new prompt, so their prior yield preference
  // is stale; the new work should follow. `yielded` alone is not enough to
  // block: the whole point of re-arm is to clear it.
  if (offTrack && !state.reArmed) {
    return { navigateTo: null, state: { ...state, yielded: true } };
  }
  if (state.yielded && !state.reArmed) return { navigateTo: null, state };
  const next: FollowNavState = { lastFollowed: followTarget, yielded: false, reArmed: false };
  // The editor is already on the target (the user opened it, or follow put them
  // there last tick) — record it so future targets dedupe, but don't re-navigate.
  if (currentDoc === followTarget) return { navigateTo: null, state: next };
  return { navigateTo: followTarget, state: next };
}

/**
 * The latest followable document across a transcript's items (last tool call
 * with a resolvable target wins — that is what the agent touched most
 * recently).
 */
export function latestFollowTarget(
  items: ReadonlyArray<{ kind: string }>,
  workspace: Workspace | null,
): string | null {
  let target: string | null = null;
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const resolved = followTargetFromToolCall(item as RenderedToolCall, workspace);
    if (resolved !== null) target = resolved;
  }
  return target;
}
