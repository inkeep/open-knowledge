import { OPEN_KNOWLEDGE_MCP_TOOLS } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { asRecord, stringField, unwrapMcpInput } from '@/lib/acp/mcp-input';

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
  preview?: string;
}

const PREVIEW_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'query',
  'pattern',
  'url',
  'prompt',
];

const PREVIEW_LIMIT = 60;

function argumentValue(rawInput: unknown): string | undefined {
  const record = asRecord(unwrapMcpInput(rawInput)?.args ?? rawInput);
  const value = PREVIEW_KEYS.map((key) => stringField(record, key)).find(
    (candidate): candidate is string => candidate !== null,
  );
  const line = value?.trim().split('\n')[0]?.trim();
  return line === undefined || line === '' ? undefined : line;
}

function ellipsize(line: string): string {
  return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT).trimEnd()}…` : line;
}

const OPEN_KNOWLEDGE_TOOLS: ReadonlySet<string> = new Set(OPEN_KNOWLEDGE_MCP_TOOLS);

const OPEN_KNOWLEDGE_SERVER = /^(?:open[-_ ]?knowledge|ok)(?:[-_][a-z]+)*$/;

const OPEN_KNOWLEDGE_TITLE =
  /^(?:mcp[^a-z0-9]+)?(?:open[-_ ]?knowledge|ok)(?:-[a-z]+)*[^a-z0-9]+([a-z_]+)$/;

const MCP_TITLE = /^mcp([^a-zA-Z0-9]+)([a-zA-Z0-9][a-zA-Z0-9_-]*?)\1([a-zA-Z0-9][a-zA-Z0-9_-]*)$/;

function mcpServerAndTool(title: string): string | null {
  const match = MCP_TITLE.exec(title.trim());
  const server = match?.[2];
  const tool = match?.[3];
  return server === undefined || tool === undefined ? null : `${server} · ${tool}`;
}

interface OpenKnowledgeCall {
  tool: string;
  args: Record<string, unknown>;
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

export function openKnowledgeToolName(call: { title: string; rawInput: unknown }): string | null {
  return identifyOpenKnowledgeCall(call.title, call.rawInput)?.tool ?? null;
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

function kindLabel(toolKind: string): string | null {
  switch (toolKind) {
    case 'read':
      return t`Read`;
    case 'edit':
      return t`Edit`;
    case 'delete':
      return t`Delete`;
    case 'move':
      return t`Move`;
    case 'search':
      return t`Search`;
    case 'execute':
      return t`Run`;
    case 'fetch':
      return t`Fetch`;
    case 'think':
      return t`Think`;
    default:
      return null;
  }
}

function openKnowledgePurpose(tool: string): string | null {
  switch (tool) {
    case 'exec':
      return t`Reads documents and folders in this project with read-only shell commands`;
    case 'search':
      return t`Finds documents and files in this project by title, content, or path`;
    case 'history':
      return t`Reads the version history of a document or skill, or a folder's activity`;
    case 'links':
      return t`Reads the link graph: what links to what`;
    case 'skills':
      return t`Finds skills and reads what's installed`;
    case 'config':
      return t`Reads this project's OpenKnowledge settings`;
    case 'palette':
      return t`Reads the authoring palette so new documents match the project's style`;
    case 'preview_url':
      return t`Gets the link that opens this project or a document in the app`;
    case 'share_link':
      return t`Builds a shareable link to a document or folder`;
    case 'lint':
      return t`Checks documents for markdown problems and can fix them`;
    case 'audit':
      return t`Checks the whole project for markdown problems and broken links`;
    case 'write':
      return t`Creates or replaces a document, folder, template, skill, or asset`;
    case 'edit':
      return t`Edits a document, folder, template, or skill in place`;
    case 'delete':
      return t`Deletes a document, folder, template, skill, or asset`;
    case 'move':
      return t`Moves or renames a document, folder, asset, template, or skill`;
    case 'install':
      return t`Makes a skill available in more places, or removes it from one`;
    case 'import':
      return t`Imports a skill into this project`;
    case 'checkpoint':
      return t`Saves a restore point for every document in the project`;
    case 'restore_version':
      return t`Restores a document or skill to an earlier version`;
    case 'conflicts':
      return t`Reads unresolved conflicts between edits`;
    case 'resolve_conflict':
      return t`Resolves a conflict by choosing which content to keep`;
    default:
      return null;
  }
}

function kindPurpose(toolKind: string): string | null {
  switch (toolKind) {
    case 'read':
      return t`Reads a file`;
    case 'edit':
      return t`Edits a file`;
    case 'delete':
      return t`Deletes a file`;
    case 'move':
      return t`Moves or renames a file`;
    case 'search':
      return t`Searches files`;
    case 'execute':
      return t`Runs a shell command`;
    case 'fetch':
      return t`Fetches a web page`;
    case 'think':
      return t`Reasons before acting`;
    case 'switch_mode':
      return t`Switches the agent's mode`;
    default:
      return null;
  }
}

export function describeToolPurpose(call: {
  title: string;
  toolKind: string;
  rawInput: unknown;
}): string | null {
  const tool = openKnowledgeToolName(call);
  if (tool !== null) return openKnowledgePurpose(tool);
  const match = MCP_TITLE.exec(call.title.trim());
  const server = match?.[2];
  const mcpTool = match?.[3];
  if (server !== undefined && mcpTool !== undefined) {
    return t`${mcpTool} from the ${server} MCP server`;
  }
  return kindPurpose(call.toolKind);
}

export function toolRunLabel(call: { title: string; toolKind: string; rawInput: unknown }): string {
  const tool = openKnowledgeToolName(call);
  if (tool !== null) return `OpenKnowledge ${tool.replace(/_/g, ' ')}`;
  return mcpServerAndTool(call.title) ?? kindLabel(call.toolKind) ?? call.title;
}

export function toolRunKey(call: { title: string; toolKind: string; rawInput: unknown }): string {
  const tool = openKnowledgeToolName(call);
  if (tool !== null) return `ok:${tool}`;
  const match = MCP_TITLE.exec(call.title.trim());
  const server = match?.[2];
  const mcpTool = match?.[3];
  if (server !== undefined && mcpTool !== undefined) return `mcp:${server}.${mcpTool}`;
  return `kind:${call.toolKind}`;
}

export function describeToolCall(call: {
  title: string;
  toolKind: string;
  rawInput: unknown;
}): ToolCallDisplay {
  const openKnowledge = identifyOpenKnowledgeCall(call.title, call.rawInput);
  if (openKnowledge !== null) return openKnowledgeDisplay(openKnowledge.tool, openKnowledge.args);
  const text = mcpServerAndTool(call.title) ?? call.title;
  const value = argumentValue(call.rawInput);
  const redundant = value !== undefined && text.includes(value);
  return {
    text,
    glyph: KIND_GLYPHS[call.toolKind] ?? 'other',
    ...(value === undefined || redundant ? {} : { preview: ellipsize(value) }),
  };
}
