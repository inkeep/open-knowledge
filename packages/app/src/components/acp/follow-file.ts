import { OPEN_KNOWLEDGE_MCP_WRITE_TOOLS } from '@inkeep/open-knowledge-core';
import { stringField, unwrapMcpInput } from '@/lib/acp/mcp-input';
import type { RenderedToolCall } from '@/lib/acp/thread-event-model';
import type { Workspace } from '@/lib/workspace-paths';

const FOLLOW_PREF_KEY = 'ok-acp-follow-file-v1';

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
  } catch {}
}

export function sanitizeDocName(docName: string): string | null {
  if (docName === '' || docName.startsWith('/') || docName.startsWith('\\')) return null;
  const segments = docName.split('/');
  if (segments.some((s) => s === '' || s.startsWith('.'))) return null;
  return docName;
}

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

function mcpDocTarget(
  rawInput: unknown,
  title: string,
  toolKind: RenderedToolCall['toolKind'],
): string | null {
  const unwrapped = unwrapMcpInput(rawInput);
  if (unwrapped === null) return null;
  const { tool, args } = unwrapped;
  if (tool === 'delete' || (tool === null && /\bdelete\b/i.test(title))) return null;
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
    return sanitizeDocName(structural.replace(/\.(md|mdx)$/, ''));
  }
  const flat = stringField(args, 'docName');
  if (flat === null) return null;
  const isKnownWrite = tool !== null && OK_MCP_WRITE_TOOLS.has(tool);
  const isWriteToolKind = toolKind === 'edit' || toolKind === 'move';
  if (!isKnownWrite && !isWriteToolKind) return null;
  return sanitizeDocName(flat.replace(/\.(md|mdx)$/, ''));
}

export function followTargetFromToolCall(
  call: Pick<RenderedToolCall, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  workspace: Workspace | null,
): string | null {
  if (call.toolKind === 'delete') return null;
  const mcp = mcpDocTarget(call.rawInput, call.title, call.toolKind);
  if (mcp !== null) return mcp;
  if (workspace === null) return null;
  if (call.toolKind !== 'edit' && call.toolKind !== 'move') return null;
  for (let i = call.locations.length - 1; i >= 0; i--) {
    const location = call.locations[i];
    if (location === undefined) continue;
    const docName = docNameFromAbsolutePath(location.path, workspace);
    if (docName === null) continue;
    return docName;
  }
  return null;
}

export interface FollowNavState {
  readonly lastFollowed: string | null;
  readonly yielded: boolean;
  readonly reArmed: boolean;
}

export const INITIAL_FOLLOW_NAV_STATE: FollowNavState = {
  lastFollowed: null,
  yielded: false,
  reArmed: false,
};

export function decideFollowNavigation(
  followTarget: string | null,
  currentDoc: string | null,
  state: FollowNavState,
): { navigateTo: string | null; state: FollowNavState } {
  if (followTarget === null) return { navigateTo: null, state };
  if (state.lastFollowed === followTarget) return { navigateTo: null, state };
  const offTrack =
    state.lastFollowed !== null &&
    currentDoc !== null &&
    currentDoc !== state.lastFollowed &&
    currentDoc !== followTarget;
  if (offTrack && !state.reArmed) {
    return { navigateTo: null, state: { ...state, yielded: true } };
  }
  if (state.yielded && !state.reArmed) return { navigateTo: null, state };
  const next: FollowNavState = { lastFollowed: followTarget, yielded: false, reArmed: false };
  if (currentDoc === followTarget) return { navigateTo: null, state: next };
  return { navigateTo: followTarget, state: next };
}

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
