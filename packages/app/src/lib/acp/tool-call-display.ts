import { OPEN_KNOWLEDGE_MCP_TOOLS } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { stringField, unwrapMcpInput } from '@/lib/acp/mcp-input';

export type ToolCallGlyph =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'check'
  | 'link'
  | 'history'
  | 'share'
  | 'install'
  | 'settings'
  | 'restore'
  | 'other';

export interface ToolCallDisplay {
  text: string;
  glyph: ToolCallGlyph;
}

const OPEN_KNOWLEDGE_TOOLS: ReadonlySet<string> = new Set(OPEN_KNOWLEDGE_MCP_TOOLS);

const OPEN_KNOWLEDGE_SERVER = /^(?:open[-_ ]?knowledge|ok)$/;

const OPEN_KNOWLEDGE_TITLE = /^(?:mcp[^a-z0-9]+)?(?:open[-_ ]?knowledge|ok)[^a-z0-9]+([a-z_]+)$/;

interface OpenKnowledgeCall {
  tool: string;
  args: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolFromTitle(title: string): string | null {
  return OPEN_KNOWLEDGE_TITLE.exec(title.trim().toLowerCase())?.[1] ?? null;
}

function identifyOpenKnowledgeCall(title: string, rawInput: unknown): OpenKnowledgeCall | null {
  const server = stringField(asRecord(rawInput), 'server');
  if (server !== null && !OPEN_KNOWLEDGE_SERVER.test(server.toLowerCase())) return null;

  const unwrapped = unwrapMcpInput(rawInput);
  const tool = [toolFromTitle(title), unwrapped?.tool ?? null].find(
    (candidate): candidate is string => candidate !== null && OPEN_KNOWLEDGE_TOOLS.has(candidate),
  );
  if (tool === undefined) return null;
  return { tool, args: unwrapped?.args ?? {} };
}

function pathsOf(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(pathsOf);
  if (typeof value === 'object' && value !== null) {
    return pathsOf((value as { path?: unknown }).path);
  }
  return [];
}

const TARGET_KEYS = [
  'document',
  'documents',
  'folder',
  'file',
  'template',
  'asset',
  'path',
  'from',
  'name',
];

function targetPaths(args: Record<string, unknown>): string[] {
  for (const key of TARGET_KEYS) {
    const found = pathsOf(args[key]);
    if (found.length > 0) return found;
  }
  return [];
}

function docLabel(path: string): string {
  return path.replace(/\.mdx?$/i, '');
}

const INLINE_MAX = 120;

function inlineText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > INLINE_MAX ? `${collapsed.slice(0, INLINE_MAX - 1)}…` : collapsed;
}

function openKnowledgeDisplay(tool: string, args: Record<string, unknown>): ToolCallDisplay {
  const found = targetPaths(args);
  const first = found[0];
  const subject: string | null =
    found.length > 1
      ? t`${plural(found.length, { one: '# document', other: '# documents' })}`
      : first === undefined
        ? null
        : docLabel(first);

  switch (tool) {
    case 'write':
      return {
        glyph: 'edit',
        text:
          subject === null
            ? t`OpenKnowledge wrote a document`
            : t`OpenKnowledge wrote to ${subject}`,
      };
    case 'edit':
      return {
        glyph: 'edit',
        text:
          subject === null
            ? t`OpenKnowledge edited a document`
            : t`OpenKnowledge edited ${subject}`,
      };
    case 'delete':
      return {
        glyph: 'delete',
        text:
          subject === null
            ? t`OpenKnowledge deleted a document`
            : t`OpenKnowledge deleted ${subject}`,
      };
    case 'move': {
      const to = pathsOf(args.to)[0];
      if (subject === null || to === undefined) {
        return { glyph: 'move', text: t`OpenKnowledge moved a document` };
      }
      const destination = docLabel(to);
      return { glyph: 'move', text: t`OpenKnowledge moved ${subject} to ${destination}` };
    }
    case 'search': {
      const query = inlineText(args.query);
      return {
        glyph: 'search',
        text:
          query === null
            ? t`OpenKnowledge searched the knowledge base`
            : t`OpenKnowledge searched for ${query}`,
      };
    }
    case 'exec': {
      const command = inlineText(args.command);
      return {
        glyph: 'execute',
        text: command === null ? t`OpenKnowledge ran a command` : t`OpenKnowledge ran ${command}`,
      };
    }
    case 'lint':
    case 'audit':
      return {
        glyph: 'check',
        text:
          subject === null
            ? t`OpenKnowledge checked the project`
            : t`OpenKnowledge checked ${subject}`,
      };
    case 'links':
      return {
        glyph: 'link',
        text:
          subject === null
            ? t`OpenKnowledge looked at the link graph`
            : t`OpenKnowledge looked up links for ${subject}`,
      };
    case 'history':
      return {
        glyph: 'history',
        text:
          subject === null
            ? t`OpenKnowledge read the edit history`
            : t`OpenKnowledge read the history of ${subject}`,
      };
    case 'config': {
      const key = inlineText(args.key);
      return {
        glyph: 'settings',
        text:
          key === null
            ? t`OpenKnowledge read the project settings`
            : t`OpenKnowledge read the setting ${key}`,
      };
    }
    case 'skills':
      return { glyph: 'read', text: t`OpenKnowledge listed the installed skills` };
    case 'install':
      return {
        glyph: 'install',
        text:
          subject === null
            ? t`OpenKnowledge installed a skill`
            : t`OpenKnowledge installed ${subject}`,
      };
    case 'import': {
      const source = inlineText(args.skill) ?? inlineText(args.source);
      return {
        glyph: 'install',
        text:
          source === null ? t`OpenKnowledge imported a skill` : t`OpenKnowledge imported ${source}`,
      };
    }
    case 'palette':
      return { glyph: 'read', text: t`OpenKnowledge looked up the authoring palette` };
    case 'preview_url':
      return { glyph: 'fetch', text: t`OpenKnowledge opened the live preview` };
    case 'share_link':
      return {
        glyph: 'share',
        text:
          subject === null
            ? t`OpenKnowledge created a share link`
            : t`OpenKnowledge created a share link for ${subject}`,
      };
    case 'checkpoint':
      return { glyph: 'history', text: t`OpenKnowledge saved a checkpoint` };
    case 'conflicts':
      return { glyph: 'check', text: t`OpenKnowledge checked for conflicts` };
    case 'resolve_conflict':
      return {
        glyph: 'edit',
        text:
          subject === null
            ? t`OpenKnowledge resolved a conflict`
            : t`OpenKnowledge resolved a conflict in ${subject}`,
      };
    case 'restore_version':
      return {
        glyph: 'restore',
        text:
          subject === null
            ? t`OpenKnowledge restored an earlier version`
            : t`OpenKnowledge restored an earlier version of ${subject}`,
      };
    default:
      return { glyph: 'other', text: t`OpenKnowledge ran ${tool}` };
  }
}

const KIND_GLYPHS: Record<string, ToolCallGlyph> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'think',
  fetch: 'fetch',
  switch_mode: 'switch_mode',
};

export function describeToolCall(call: {
  title: string;
  toolKind: string;
  rawInput: unknown;
}): ToolCallDisplay {
  const openKnowledge = identifyOpenKnowledgeCall(call.title, call.rawInput);
  if (openKnowledge !== null) return openKnowledgeDisplay(openKnowledge.tool, openKnowledge.args);
  return { text: call.title, glyph: KIND_GLYPHS[call.toolKind] ?? 'other' };
}
