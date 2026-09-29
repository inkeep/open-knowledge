import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { asRecord, stringField } from '@inkeep/open-knowledge-core/acp/tool-call-input';
import { tracedMkdir, tracedRm, tracedWriteFile } from '../fs-traced.ts';
import { resolveOnPath } from '../git-preflight.ts';
import { runBrowserRelay } from './browser-relay.ts';
import { isMintedThreadId } from './thread-persistence.ts';

export const AGENT_BROWSER_MCP_PACKAGE = '@playwright/mcp@0.0.82';

const AGENT_BROWSER_SERVER_NAME = 'ok-browser';

const CODEX_AGENT_ID = 'codex-acp';

const BROWSER_AGENT_IDS: ReadonlySet<string> = new Set(['claude-acp', CODEX_AGENT_ID]);

const BROWSER_TOOL_NAME = /^browser_[a-z_]+$/;

const BROWSER_TOOL_TITLE = /^(?:mcp[^a-z0-9]+)?ok[^a-z0-9]?browser[^a-z0-9]+(browser_[a-z_]+)$/;

const CLAUDE_MCP_TOOL = /^mcp__(.+?)__(.+)$/;

const CODEX_MCP_TITLE = /^mcp\.([^.]+)\.(.+)$/;

const CODEX_TOOL_TITLE = /^Tool: ([^/\s]+)\/(\S+)$/;

const DISPLAY_ENV = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'] as const;

const AGENT_BROWSER_DIR = 'agent-browser';

export function agentGetsBrowser(agentRef: {
  readonly source: 'registry' | 'custom';
  readonly id: string;
}): boolean {
  return agentRef.source === 'registry' && BROWSER_AGENT_IDS.has(agentRef.id);
}

export type BrowserCallIdentity =
  | { readonly kind: 'none' }
  | { readonly kind: 'browser'; readonly tool: string }
  | { readonly kind: 'unverified' };

export const NOT_A_BROWSER_CALL: BrowserCallIdentity = { kind: 'none' };

const UNVERIFIED_BROWSER_CALL: BrowserCallIdentity = { kind: 'unverified' };

export interface BrowserCallEvidence {
  readonly title?: string | null;
  readonly kind?: string | null;
  readonly rawInput?: unknown;
  readonly _meta?: unknown;
}

function browserServerTool(server: string, tool: string): BrowserCallIdentity {
  if (server !== AGENT_BROWSER_SERVER_NAME) return NOT_A_BROWSER_CALL;
  return BROWSER_TOOL_NAME.test(tool) ? { kind: 'browser', tool } : UNVERIFIED_BROWSER_CALL;
}

function codexMcpCall(call: BrowserCallEvidence): BrowserCallIdentity {
  const match = CODEX_MCP_TITLE.exec((call.title ?? '').trim());
  if (match === null) return UNVERIFIED_BROWSER_CALL;
  const [, server = '', tool = ''] = match;
  return codexNamedCall(call, server, tool);
}

function codexNamedCall(
  call: BrowserCallEvidence,
  server: string,
  tool: string,
): BrowserCallIdentity {
  const input = asRecord(call.rawInput);
  const inputServer = stringField(input, 'server');
  const inputTool = stringField(input, 'tool');
  if (
    (inputServer !== null && inputServer !== server) ||
    (inputTool !== null && inputTool !== tool)
  ) {
    return UNVERIFIED_BROWSER_CALL;
  }
  return browserServerTool(server, tool);
}

export function identifyBrowserCall(
  call: BrowserCallEvidence,
  context: {
    readonly requestMeta?: unknown;
    readonly browserInjected: boolean;
    readonly agentId: string;
  },
): BrowserCallIdentity {
  if (!context.browserInjected) return NOT_A_BROWSER_CALL;
  const meta = asRecord(call._meta);
  const claudeTool = stringField(asRecord(meta?.claudeCode), 'toolName');
  if (claudeTool !== null) {
    const match = CLAUDE_MCP_TOOL.exec(claudeTool);
    return match === null ? NOT_A_BROWSER_CALL : browserServerTool(match[1] ?? '', match[2] ?? '');
  }
  const codex = context.agentId === CODEX_AGENT_ID;
  if (codex && meta?.is_mcp_tool_call === true) return codexMcpCall(call);
  const title = (call.title ?? '').trim();
  const codexTool = codex ? CODEX_TOOL_TITLE.exec(title) : null;
  if (codexTool != null) return codexNamedCall(call, codexTool[1] ?? '', codexTool[2] ?? '');
  const titleTool = BROWSER_TOOL_TITLE.exec(title.toLowerCase())?.[1];
  if (titleTool !== undefined) return { kind: 'browser', tool: titleTool };
  if (!codex) return UNVERIFIED_BROWSER_CALL;
  const input = asRecord(call.rawInput);
  const namedServer =
    stringField(input, 'serverName') ??
    stringField(input, 'server_name') ??
    stringField(input, 'server');
  if (asRecord(context.requestMeta)?.is_mcp_tool_approval === true || namedServer !== null) {
    return namedServer !== null && namedServer.toLowerCase() !== AGENT_BROWSER_SERVER_NAME
      ? NOT_A_BROWSER_CALL
      : UNVERIFIED_BROWSER_CALL;
  }
  const commandOrPatch =
    input !== null && (input.command !== undefined || input.changes !== undefined);
  return call.kind != null && call.kind !== 'other' && commandOrPatch
    ? NOT_A_BROWSER_CALL
    : UNVERIFIED_BROWSER_CALL;
}

export function needsReportedToolCall(
  call: BrowserCallEvidence,
  requestMeta: unknown,
  agentId: string,
): boolean {
  return (
    identifyBrowserCall(call, { requestMeta, browserInjected: true, agentId }).kind === 'unverified'
  );
}

export interface ResolvedBrowserNpx {
  readonly npx: string;
  readonly path: string;
}

export function resolveBrowserNpx(
  pathCandidates: readonly (string | null | undefined)[],
  resolveCommand: (name: string, path: string) => string | null = resolveOnPath,
  accept: (npx: string) => boolean = () => true,
): ResolvedBrowserNpx | null {
  for (const path of pathCandidates) {
    if (path === null || path === undefined || path === '') continue;
    const npx = resolveCommand('npx', path);
    if (npx !== null && accept(npx)) return { npx, path };
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const AGENT_BROWSER_TOOLS: readonly string[] = [
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
];

const BROWSER_SERVER_RELAY = `(${runBrowserRelay.toString()})(require('node:child_process'), require('node:url'), ${JSON.stringify(AGENT_BROWSER_TOOLS)});`;

export interface AgentBrowserFolders {
  readonly npm: string;
  readonly files: string;
}

export function agentBrowserMcpServer(opts: {
  npx: ResolvedBrowserNpx;
  folders: AgentBrowserFolders;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): McpServerStdio | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const runtime = npxRuntime(opts.npx.npx, platform, opts.exists ?? isFile);
  if (runtime === null) return null;
  const noDisplay =
    platform === 'linux' && (env.DISPLAY ?? '') === '' && (env.WAYLAND_DISPLAY ?? '') === '';
  const displayEnv =
    platform === 'linux' && !noDisplay
      ? DISPLAY_ENV.flatMap((name) => {
          const value = env[name];
          return value === undefined || value === '' ? [] : [{ name, value }];
        })
      : [];
  return {
    name: AGENT_BROWSER_SERVER_NAME,
    command: runtime.node,
    args: [
      '-e',
      BROWSER_SERVER_RELAY,
      opts.folders.npm,
      opts.folders.files,
      ...runtime.npx,
      '--prefix',
      opts.folders.npm,
      '-y',
      AGENT_BROWSER_MCP_PACKAGE,
      '--isolated',
      '--no-webmcp',
      '--output-dir',
      opts.folders.files,
      '--file-paths',
      'absolute',
      ...(noDisplay ? ['--headless'] : []),
    ],
    env: [{ name: 'PATH', value: opts.npx.path }, ...displayEnv],
  };
}

function npxRuntime(
  npx: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): { node: string; npx: readonly string[] } | null {
  const nodeDir = dirname(npx);
  if (platform !== 'win32') {
    const node = join(nodeDir, 'node');
    return exists(node) ? { node, npx: [npx] } : null;
  }
  const node = join(nodeDir, 'node.exe');
  const npxCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return exists(node) && exists(npxCli) ? { node, npx: [node, npxCli] } : null;
}

export function browserNpxRunnable(
  npx: string,
  opts: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): boolean {
  return npxRuntime(npx, opts.platform ?? process.platform, opts.exists ?? isFile) !== null;
}

function agentBrowserPath(root: string, threadId: string): string | null {
  return isMintedThreadId(threadId) ? resolve(root, AGENT_BROWSER_DIR, threadId) : null;
}

export async function prepareAgentBrowserFolders(
  root: string,
  threadId: string,
): Promise<AgentBrowserFolders> {
  const chat = agentBrowserPath(root, threadId);
  if (chat === null) throw new Error('browser folders need a chat id OpenKnowledge minted');
  const folders = { npm: join(chat, 'npm'), files: join(chat, 'files') };
  await tracedMkdir(dirname(chat), { recursive: true, mode: 0o700 });
  await tracedMkdir(chat, { recursive: true, mode: 0o700 });
  await tracedRm(folders.npm, { recursive: true, force: true });
  await tracedMkdir(folders.npm, { mode: 0o700 });
  await tracedWriteFile(
    join(folders.npm, 'package.json'),
    `${JSON.stringify({ name: 'openknowledge-agent-browser', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  await tracedMkdir(folders.files, { recursive: true, mode: 0o700 });
  return folders;
}

export async function removeAgentBrowserFolders(root: string, threadId: string): Promise<void> {
  const chat = agentBrowserPath(root, threadId);
  if (chat === null) return;
  await tracedRm(chat, { recursive: true, force: true });
}
