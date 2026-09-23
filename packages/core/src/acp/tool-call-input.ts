import { OPEN_KNOWLEDGE_MCP_TOOLS, type OpenKnowledgeMcpTool } from '../constants/mcp.ts';

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface UnwrappedMcpInput {
  tool: string | null;
  args: Record<string, unknown>;
}

export function unwrapMcpInput(rawInput: unknown): UnwrappedMcpInput | null {
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
    } catch {}
  }
  return { tool, args };
}

export interface ToolCallInput {
  readonly title?: string | null;
  readonly rawInput?: unknown;
}

export interface OpenKnowledgeToolCall {
  tool: OpenKnowledgeMcpTool;
  args: Record<string, unknown>;
}

export type OpenKnowledgeServerMatch = 'any' | 'known';

const OPEN_KNOWLEDGE_TOOLS: ReadonlySet<string> = new Set(OPEN_KNOWLEDGE_MCP_TOOLS);

const ANY_OPEN_KNOWLEDGE_SERVER = /^(?:open[-_ ]?knowledge|ok)(?:[-_][a-z]+)*$/;

const KNOWN_OPEN_KNOWLEDGE_SERVER = /^open[-_ ]?knowledge(?:-dev)?$/;

const PI_BRIDGE_PREFIX = 'ok';

const OPEN_KNOWLEDGE_TITLE =
  /^(mcp[^a-z0-9]+)?((?:open[-_ ]?knowledge|ok)(?:-[a-z]+)*)[^a-z0-9]+([a-z_]+)$/;

function isOpenKnowledgeTool(candidate: string | null): candidate is OpenKnowledgeMcpTool {
  return candidate !== null && OPEN_KNOWLEDGE_TOOLS.has(candidate);
}

export function identifyOpenKnowledgeToolCall(
  call: ToolCallInput,
  servers: OpenKnowledgeServerMatch = 'any',
): OpenKnowledgeToolCall | null {
  const serverPattern =
    servers === 'known' ? KNOWN_OPEN_KNOWLEDGE_SERVER : ANY_OPEN_KNOWLEDGE_SERVER;
  const inputServer = stringField(asRecord(call.rawInput), 'server')?.toLowerCase() ?? null;
  if (inputServer !== null && !serverPattern.test(inputServer)) return null;

  const titleMatch = OPEN_KNOWLEDGE_TITLE.exec((call.title ?? '').trim().toLowerCase());
  const titleViaMcp = titleMatch?.[1] !== undefined;
  const titleServer = titleMatch?.[2] ?? null;
  const titleTool = titleMatch?.[3] ?? null;
  const unwrapped = unwrapMcpInput(call.rawInput);
  if (servers === 'known') {
    if (titleServer === null) return null;
    const knownServer = titleViaMcp
      ? serverPattern.test(titleServer)
      : titleServer === PI_BRIDGE_PREFIX && inputServer === null;
    if (!knownServer) return null;
    if (!isOpenKnowledgeTool(titleTool)) return null;
    const inputTool = unwrapped?.tool ?? null;
    if (inputTool !== null && inputTool !== titleTool) return null;
    return { tool: titleTool, args: unwrapped?.args ?? {} };
  }

  const tool = [titleTool, unwrapped?.tool ?? null].find(isOpenKnowledgeTool);
  if (tool === undefined) return null;
  return { tool, args: unwrapped?.args ?? {} };
}

export function openKnowledgeToolName(call: ToolCallInput): OpenKnowledgeMcpTool | null {
  return identifyOpenKnowledgeToolCall(call)?.tool ?? null;
}

const POSIX_SHELL = /^(?:\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/)?(?:ba|da|z)?sh$/;

const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/;

const HAS_TEXT = /[^ \t\n]/;

export function shellCommandFromRawInput(rawInput: unknown): string | null {
  const value = asRecord(rawInput).command;
  const command = Array.isArray(value) ? commandFromArgv(value) : value;
  return typeof command === 'string' && HAS_TEXT.test(command) ? command : null;
}

function commandFromArgv(argv: readonly unknown[]): string | null {
  if (argv.length === 0 || !argv.every((part): part is string => typeof part === 'string')) {
    return null;
  }
  const [shell = '', flag, script = ''] = argv;
  if (argv.length === 3 && POSIX_SHELL.test(shell) && (flag === '-c' || flag === '-lc')) {
    return script;
  }
  return argv.map(quoteArgument).join(' ');
}

function quoteArgument(argument: string): string {
  return PLAIN_ARGUMENT.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}
