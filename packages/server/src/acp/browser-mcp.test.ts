import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveOnPath } from '../git-preflight.ts';
import {
  AGENT_BROWSER_MCP_PACKAGE,
  agentBrowserMcpServer,
  agentGetsBrowser,
  type BrowserCallEvidence,
  browserNpxRunnable,
  identifyBrowserCall,
  needsReportedToolCall,
  prepareAgentBrowserFolders,
  removeAgentBrowserFolders,
  resolveBrowserNpx,
} from './browser-mcp.ts';

let dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-mcp-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const NPX = { npx: '/opt/node/bin/npx', path: '/opt/node/bin:/usr/bin' };

const THREAD = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

const claude = { browserInjected: true, agentId: 'claude-acp' };

const codex = { browserInjected: true, agentId: 'codex-acp' };

const claudeCall = (toolName: string, extra: BrowserCallEvidence = {}): BrowserCallEvidence => ({
  title: toolName,
  ...extra,
  _meta: { claudeCode: { toolName } },
});

const codexCall = (server: string, tool: string): BrowserCallEvidence => ({
  title: `mcp.${server}.${tool}`,
  rawInput: { server, tool, arguments: {} },
  _meta: { is_mcp_tool_call: true },
});

describe('identifyBrowserCall', () => {
  test('finds nothing in a chat that was not given the browser', () => {
    const notInjected = { browserInjected: false, agentId: 'claude-acp' };
    expect(
      identifyBrowserCall(claudeCall('mcp__ok-browser__browser_navigate'), notInjected),
    ).toEqual({
      kind: 'none',
    });
    expect(
      identifyBrowserCall({ title: 'mcp__ok-browser__browser_navigate' }, notInjected),
    ).toEqual({
      kind: 'none',
    });
  });

  test("takes Claude's tool from the adapter's metadata, never from the model's arguments or title", () => {
    expect(identifyBrowserCall(claudeCall('mcp__ok-browser__browser_navigate'), claude)).toEqual({
      kind: 'browser',
      tool: 'browser_navigate',
    });
    expect(
      identifyBrowserCall(
        claudeCall('mcp__ok-browser__browser_run_code_unsafe', {
          rawInput: { server: 'ok-browser', tool: 'browser_navigate' },
        }),
        claude,
      ),
    ).toEqual({ kind: 'browser', tool: 'browser_run_code_unsafe' });
    expect(
      identifyBrowserCall(
        claudeCall('mcp__ok-browser__browser_run_code_unsafe', { rawInput: { server: 'x' } }),
        claude,
      ),
    ).toEqual({ kind: 'browser', tool: 'browser_run_code_unsafe' });
    expect(
      identifyBrowserCall(
        { title: 'mcp__ok-browser__browser_navigate', _meta: { claudeCode: { toolName: 'Bash' } } },
        claude,
      ),
    ).toEqual({ kind: 'none' });
    expect(identifyBrowserCall(claudeCall('mcp__github__browser_navigate'), claude)).toEqual({
      kind: 'none',
    });
    expect(identifyBrowserCall(claudeCall('mcp__ok-browser__Evaluate'), claude)).toEqual({
      kind: 'unverified',
    });
  });

  test("settles a Claude call without the adapter's tool name only from a browser title", () => {
    expect(identifyBrowserCall({ title: 'mcp__ok-browser__browser_snapshot' }, claude)).toEqual({
      kind: 'browser',
      tool: 'browser_snapshot',
    });
    const unsettled: BrowserCallEvidence[] = [
      { title: 'Open the page', rawInput: { url: 'https://example.com', server: 'github' } },
      { title: 'Tool: github/create_issue', rawInput: { server: 'github', tool: 'create_issue' } },
      { title: 'Approve it', rawInput: { server_name: 'github' } },
      { title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } },
      { title: 'Run it', _meta: { is_mcp_tool_call: true }, rawInput: { server: 'github' } },
      { title: null, rawInput: undefined },
    ];
    for (const call of unsettled) {
      expect(identifyBrowserCall(call, claude), JSON.stringify(call)).toEqual({
        kind: 'unverified',
      });
    }
  });

  test("takes Codex's tool from its MCP call title, and distrusts a call whose parts disagree", () => {
    expect(identifyBrowserCall(codexCall('ok-browser', 'browser_click'), codex)).toEqual({
      kind: 'browser',
      tool: 'browser_click',
    });
    expect(identifyBrowserCall(codexCall('github', 'browser_click'), codex)).toEqual({
      kind: 'none',
    });
    expect(
      identifyBrowserCall(
        {
          ...codexCall('ok-browser', 'browser_click'),
          rawInput: { server: 'ok-browser', tool: 'browser_navigate' },
        },
        codex,
      ),
    ).toEqual({ kind: 'unverified' });
    expect(
      identifyBrowserCall({ title: 'Run tool', _meta: { is_mcp_tool_call: true } }, codex),
    ).toEqual({ kind: 'unverified' });
  });

  test('treats a Codex MCP approval it cannot tie to a tool as unverified unless another server is named', () => {
    const approval = { requestMeta: { is_mcp_tool_approval: true }, ...codex };
    expect(identifyBrowserCall({}, approval)).toEqual({ kind: 'unverified' });
    expect(
      identifyBrowserCall(
        { title: 'MCP tool call approval', rawInput: { serverName: 'ok-browser' } },
        approval,
      ),
    ).toEqual({ kind: 'unverified' });
    expect(
      identifyBrowserCall(
        { title: 'MCP tool call approval', rawInput: { serverName: 'github' } },
        approval,
      ),
    ).toEqual({ kind: 'none' });
  });

  test("reads Codex's newer tool calls and approvals, which carry no MCP marker", () => {
    const toolCall = (
      server: string,
      tool: string,
      rawInput: Record<string, unknown> = { server, tool, arguments: {} },
    ): BrowserCallEvidence => ({ title: `Tool: ${server}/${tool}`, rawInput });
    expect(identifyBrowserCall(toolCall('ok-browser', 'browser_click'), codex)).toEqual({
      kind: 'browser',
      tool: 'browser_click',
    });
    expect(identifyBrowserCall(toolCall('github', 'create_issue'), codex)).toEqual({
      kind: 'none',
    });
    expect(
      identifyBrowserCall(
        toolCall('ok-browser', 'browser_click', { server: 'ok-browser', tool: 'browser_navigate' }),
        codex,
      ),
    ).toEqual({ kind: 'unverified' });
    const approval = (serverName: string): BrowserCallEvidence => ({
      title: 'Approve Navigate to a URL',
      rawInput: { server_name: serverName, id: 'mcp_tool_call_approval_c1', request: {} },
    });
    expect(identifyBrowserCall(approval('ok-browser'), codex)).toEqual({ kind: 'unverified' });
    expect(identifyBrowserCall(approval('github'), codex)).toEqual({ kind: 'none' });
    expect(
      identifyBrowserCall(
        { title: 'Run npm test', kind: 'execute', rawInput: { call_id: 'c2', command: ['npm'] } },
        codex,
      ),
    ).toEqual({ kind: 'none' });
  });

  test('settles a Codex call without a marker only from the envelope its adapter builds', () => {
    expect(
      identifyBrowserCall(
        { title: 'mcp__ok-browser__browser_snapshot', rawInput: { server: 'github' } },
        codex,
      ),
    ).toEqual({ kind: 'browser', tool: 'browser_snapshot' });
    expect(
      identifyBrowserCall({ title: 'Run it', rawInput: { server: 'ok-browser' } }, codex),
    ).toEqual({ kind: 'unverified' });
    expect(identifyBrowserCall({ title: 'Run it', rawInput: { server: 'github' } }, codex)).toEqual(
      {
        kind: 'none',
      },
    );
    expect(
      identifyBrowserCall({ title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } }, codex),
    ).toEqual({ kind: 'none' });
    expect(
      identifyBrowserCall({ title: 'Edit files', kind: 'edit', rawInput: { changes: {} } }, codex),
    ).toEqual({ kind: 'none' });
    const unsettled: BrowserCallEvidence[] = [
      { title: 'Bash', rawInput: { command: 'ls' } },
      { title: 'Do it', kind: 'other' },
      { title: 'Run it', kind: 'execute' },
      { title: 'Read', kind: 'read', rawInput: { file_path: 'a' } },
      { title: null, rawInput: undefined },
    ];
    for (const call of unsettled) {
      expect(identifyBrowserCall(call, codex), JSON.stringify(call)).toEqual({
        kind: 'unverified',
      });
    }
  });
});

describe('needsReportedToolCall', () => {
  test('waits for the reported tool call only when the request alone cannot settle what it runs', () => {
    const waits = (call: BrowserCallEvidence, agentId: string, requestMeta?: unknown) =>
      needsReportedToolCall(call, requestMeta, agentId);
    expect(waits({ title: null }, 'claude-acp')).toBe(true);
    expect(waits({ _meta: { claudeCode: { toolName: 'Bash' } } }, 'claude-acp')).toBe(false);
    expect(waits({ title: 'mcp__ok-browser__browser_snapshot', rawInput: {} }, 'claude-acp')).toBe(
      false,
    );
    expect(waits(claudeCall('mcp__ok-browser__browser_snapshot'), 'claude-acp')).toBe(false);
    expect(waits({ title: 'Open it', rawInput: { server: 'github' } }, 'claude-acp')).toBe(true);
    const approval = { is_mcp_tool_approval: true };
    expect(
      waits(
        { title: 'MCP tool call approval', rawInput: { serverName: 'ok-browser' } },
        'codex-acp',
        approval,
      ),
    ).toBe(true);
    expect(
      waits(
        { title: 'MCP tool call approval', rawInput: { serverName: 'github' } },
        'codex-acp',
        approval,
      ),
    ).toBe(false);
    expect(
      waits(
        { title: 'Run npm test', kind: 'execute', rawInput: { command: 'npm test' } },
        'codex-acp',
      ),
    ).toBe(false);
    expect(waits({ title: 'Run npm test', rawInput: { command: 'npm test' } }, 'codex-acp')).toBe(
      true,
    );
  });
});

describe('agentGetsBrowser', () => {
  test('is limited to the registry agents whose adapters say which tool each call runs', () => {
    expect(agentGetsBrowser({ source: 'registry', id: 'claude-acp' })).toBe(true);
    expect(agentGetsBrowser({ source: 'registry', id: 'codex-acp' })).toBe(true);
    for (const id of ['gemini', 'cursor', 'opencode', 'github-copilot-cli', 'pi-acp']) {
      expect(agentGetsBrowser({ source: 'registry', id })).toBe(false);
    }
    expect(agentGetsBrowser({ source: 'custom', id: 'claude-acp' })).toBe(false);
  });
});

describe('agentBrowserMcpServer', () => {
  const FOLDERS = {
    npm: '/home/me/.ok/agent-browser/chat/npm',
    files: '/home/me/.ok/agent-browser/chat/files',
  };

  test('starts the pinned package through the relay and the npx it resolved, from the chat npm folder', () => {
    const server = agentBrowserMcpServer({
      npx: NPX,
      folders: FOLDERS,
      platform: 'darwin',
      env: {},
      exists: (path) => path === '/opt/node/bin/node',
    });
    expect(server).toEqual({
      name: 'ok-browser',
      command: '/opt/node/bin/node',
      args: [
        '-e',
        expect.any(String),
        FOLDERS.npm,
        FOLDERS.files,
        '/opt/node/bin/npx',
        '--prefix',
        FOLDERS.npm,
        '-y',
        AGENT_BROWSER_MCP_PACKAGE,
        '--isolated',
        '--no-webmcp',
        '--output-dir',
        FOLDERS.files,
        '--file-paths',
        'absolute',
      ],
      env: [{ name: 'PATH', value: '/opt/node/bin:/usr/bin' }],
    });
    expect(
      agentBrowserMcpServer({
        npx: NPX,
        folders: FOLDERS,
        platform: 'darwin',
        env: {},
        exists: () => false,
      }),
    ).toBeNull();
  });

  test('runs headless only on Linux with no display', () => {
    const headless = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
      agentBrowserMcpServer({
        npx: NPX,
        folders: FOLDERS,
        platform,
        env,
        exists: () => true,
      })?.args.includes('--headless');
    expect(headless('linux', {})).toBe(true);
    expect(headless('linux', { DISPLAY: ':0' })).toBe(false);
    expect(headless('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(headless('darwin', {})).toBe(false);
  });

  test('passes the display on to the browser when it runs with a window on Linux', () => {
    const env = (platform: NodeJS.Platform, processEnv: NodeJS.ProcessEnv) =>
      agentBrowserMcpServer({
        npx: NPX,
        folders: FOLDERS,
        platform,
        env: processEnv,
        exists: () => true,
      })?.env;
    const path = { name: 'PATH', value: NPX.path };
    expect(env('linux', { DISPLAY: ':0', XAUTHORITY: '/home/me/.Xauthority', HOME: '/h' })).toEqual(
      [
        path,
        { name: 'DISPLAY', value: ':0' },
        { name: 'XAUTHORITY', value: '/home/me/.Xauthority' },
      ],
    );
    expect(env('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1' })).toEqual([
      path,
      { name: 'WAYLAND_DISPLAY', value: 'wayland-0' },
      { name: 'XDG_RUNTIME_DIR', value: '/run/user/1' },
    ]);
    expect(env('linux', { XAUTHORITY: '/home/me/.Xauthority' })).toEqual([path]);
    expect(env('darwin', { DISPLAY: ':0' })).toEqual([path]);
  });

  test('on Windows runs npm through the node that ships beside npx, or not at all', () => {
    const npx = { npx: join('C:', 'nodejs', 'npx'), path: join('C:', 'nodejs') };
    const node = join('C:', 'nodejs', 'node.exe');
    const npxCli = join('C:', 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const server = agentBrowserMcpServer({
      npx,
      folders: FOLDERS,
      platform: 'win32',
      env: {},
      exists: (path) => path === node || path === npxCli,
    });
    expect(server?.command).toBe(node);
    expect(server?.args[0]).toBe('-e');
    expect(server?.args.slice(2, 10)).toEqual([
      FOLDERS.npm,
      FOLDERS.files,
      node,
      npxCli,
      '--prefix',
      FOLDERS.npm,
      '-y',
      AGENT_BROWSER_MCP_PACKAGE,
    ]);
    expect(
      agentBrowserMcpServer({
        npx,
        folders: FOLDERS,
        platform: 'win32',
        env: {},
        exists: () => false,
      }),
    ).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('the browser server relay', () => {
  function relayArgs(): string[] {
    const server = agentBrowserMcpServer({
      npx: NPX,
      folders: { npm: '/n', files: '/f' },
      platform: 'darwin',
      env: {},
      exists: () => true,
    });
    if (server === null) throw new Error('fixture');
    return server.args.slice(0, 2);
  }

  const UNUSUAL_ROOTS_REQUESTS = [
    String.raw`{"jsonrpc":"2.0","id":"srv-escaped","method":"roots\/list"}`,
    '[{"jsonrpc":"2.0","id":"srv-batch","method":"roots/list"}]',
    '{"jsonrpc":"2.0","id":"srv-torn","method":"roots/li',
  ];

  const TOOLS = [
    { name: 'browser_snapshot', annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'browser_click', annotations: { readOnlyHint: false } },
    {
      name: 'browser_run_code_unsafe',
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    { name: 'browser_run_code', annotations: { readOnlyHint: false } },
    { name: 'browser_brand_new_tool' },
    { name: 'browser_resize' },
  ];

  function fakeMcpServer(root: string): { command: string; received: string; cwd: string } {
    const received = join(root, 'received.ndjson');
    const cwd = join(root, 'cwd.txt');
    const command = join(root, 'fake-mcp-server.mjs');
    const serverInfo = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1' },
    };
    writeFileSync(
      command,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(cwd)}, process.cwd());`,
        "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
        "let pending = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  pending += chunk;',
        "  let at = pending.indexOf('\\n');",
        '  while (at !== -1) {',
        '    const line = pending.slice(0, at);',
        '    pending = pending.slice(at + 1);',
        "    at = pending.indexOf('\\n');",
        `    appendFileSync(${JSON.stringify(received)}, line + '\\n');`,
        '    const message = JSON.parse(line);',
        '    if (message.method === undefined) continue;',
        "    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: 'srv-roots', method: 'roots/list' });",
        `    if (message.method === 'test/unusual-roots') process.stdout.write(${JSON.stringify(`${UNUSUAL_ROOTS_REQUESTS.join('\n')}\n`)});`,
        `    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list' ? { tools: ${JSON.stringify(TOOLS)} } : ${JSON.stringify(serverInfo)} });`,
        '  }',
        '});',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { command, received, cwd };
  }

  async function runRelay(
    npm: string,
    files: string,
    command: string,
    messages: readonly unknown[],
    settled: () => boolean,
  ): Promise<string> {
    const child = spawn(process.execPath, [...relayArgs(), npm, files, command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolveExit) => child.on('close', resolveExit));
    for (const message of messages) {
      child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    }
    const deadline = Date.now() + 10_000;
    while (!settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();
    expect(await exited).toBe(0);
    return stdout;
  }

  const initialize = (capabilities: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities,
      clientInfo: { name: 'agent', version: '1' },
    },
  });

  const receivedLines = (path: string): Array<Record<string, unknown>> =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];

  test("answers the server's roots request with the chat's files folder instead of the agent's roots", async () => {
    const root = tmp();
    const npm = join(root, 'npm');
    const files = join(root, 'files');
    mkdirSync(npm);
    mkdirSync(files);
    const server = fakeMcpServer(root);
    const stdout = await runRelay(
      npm,
      files,
      server.command,
      [
        initialize({ roots: { listChanged: true }, elicitation: {} }),
        { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
      ],
      () => receivedLines(server.received).some((m) => m.id === 'srv-roots'),
    );
    const received = receivedLines(server.received);
    const init = received.find((m) => m.method === 'initialize') as {
      params: { capabilities: unknown; clientInfo: unknown };
    };
    expect(init.params.capabilities).toEqual({ roots: { listChanged: false }, elicitation: {} });
    expect(init.params.clientInfo).toEqual({ name: 'agent', version: '1' });
    expect(received.find((m) => m.id === 'srv-roots')).toEqual({
      jsonrpc: '2.0',
      id: 'srv-roots',
      result: { roots: [{ uri: pathToFileURL(files).href, name: 'chat files' }] },
    });
    expect(received.some((m) => m.method === 'notifications/roots/list_changed')).toBe(false);
    expect(stdout).not.toContain('roots/list');
    expect(JSON.parse(stdout.trim()).result.serverInfo.name).toBe('fake');
    expect(readFileSync(server.cwd, 'utf8')).toBe(realpathSync(npm));
  });

  test('asks the server for roots even when the agent offers none', async () => {
    const root = tmp();
    const server = fakeMcpServer(root);
    await runRelay(root, root, server.command, [initialize({})], () =>
      receivedLines(server.received).some((m) => m.id === 'srv-roots'),
    );
    const init = receivedLines(server.received).find((m) => m.method === 'initialize') as {
      params: { capabilities: unknown };
    };
    expect(init.params.capabilities).toEqual({ roots: { listChanged: false } });
  });

  test('forwards only the vetted browser tools and refuses calls to any other', async () => {
    const root = tmp();
    const server = fakeMcpServer(root);
    const call = (id: number, name: string) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: { filename: 'helper.js' } },
    });
    const stdout = await runRelay(
      root,
      root,
      server.command,
      [
        call(3, 'browser_run_code_unsafe'),
        call(5, 'browser_run_code'),
        call(6, 'browser_click'),
        { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      ],
      () => receivedLines(server.received).some((m) => m.id === 4),
    );
    expect(receivedLines(server.received).map((m) => m.id)).toEqual([6, 4]);
    const replies = stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            id: number;
            error?: unknown;
            result?: { tools: Array<{ name: string }> };
          },
      );
    for (const [id, name] of [
      [3, 'browser_run_code_unsafe'],
      [5, 'browser_run_code'],
    ] as const) {
      expect(replies.find((r) => r.id === id)?.error).toEqual({
        code: -32602,
        message: `Tool ${name} is not available`,
      });
    }
    expect(replies.find((r) => r.id === 4)?.result?.tools.map((t) => t.name)).toEqual([
      'browser_snapshot',
      'browser_click',
      'browser_resize',
    ]);
  });

  test('refuses a client line it cannot read as one message, however the call is encoded', async () => {
    const root = tmp();
    const server = fakeMcpServer(root);
    const call = (id: number) =>
      `"id":${id},"params":{"name":"browser_run_code_unsafe","arguments":{}}`;
    const stdout = await runRelay(
      root,
      root,
      server.command,
      [
        String.raw`{"jsonrpc":"2.0",${call(7)},"method":"tools\/call"}`,
        String.raw`{"jsonrpc":"2.0",${call(8)},"method":"\u0074ools/call"}`,
        `[{"jsonrpc":"2.0",${call(9)},"method":"tools/call"}]`,
        `{"jsonrpc":"2.0",${call(10)},"method":"tools/ca`,
        { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
      ],
      () => receivedLines(server.received).some((m) => m.id === 11),
    );
    expect(receivedLines(server.received).map((m) => m.id)).toEqual([11]);
    const replies = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; error?: { code: number } });
    expect(replies.find((r) => r.id === 7)?.error?.code).toBe(-32602);
    expect(replies.find((r) => r.id === 8)?.error?.code).toBe(-32602);
    expect(replies.find((r) => r.id === 9)?.error?.code).toBe(-32600);
    expect(replies.some((r) => r.id === 10)).toBe(false);
  });

  test("keeps the server's roots requests from the agent, however they are encoded", async () => {
    const root = tmp();
    const files = join(root, 'files');
    const server = fakeMcpServer(root);
    const stdout = await runRelay(
      root,
      files,
      server.command,
      [{ jsonrpc: '2.0', id: 12, method: 'test/unusual-roots', params: {} }],
      () => receivedLines(server.received).some((m) => m.id === 'srv-batch'),
    );
    const received = receivedLines(server.received);
    expect(received.find((m) => m.id === 'srv-escaped')?.result).toEqual({
      roots: [{ uri: pathToFileURL(files).href, name: 'chat files' }],
    });
    expect(received.find((m) => m.id === 'srv-batch')?.error).toMatchObject({ code: -32600 });
    expect(stdout).not.toContain('roots');
  });

  test('marks every tool as not read-only, so agents ask before each browser action', () => {
    const root = tmp();
    const server = fakeMcpServer(root);
    const result = spawnSync(process.execPath, [...relayArgs(), root, root, server.command], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).result.tools).toEqual([
      { name: 'browser_snapshot', annotations: { readOnlyHint: false, openWorldHint: true } },
      { name: 'browser_click', annotations: { readOnlyHint: false } },
      { name: 'browser_resize' },
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('the browser server launch, run for real', () => {
  const PROBE_PACKAGE = 'ok-browser-probe';

  function plantProbe(root: string, identity: string): void {
    const pkg = join(root, 'node_modules', PROBE_PACKAGE);
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: PROBE_PACKAGE, version: '1.0.0', bin: { [PROBE_PACKAGE]: 'cli.js' } }),
    );
    writeFileSync(
      join(pkg, 'cli.js'),
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.OK_PROBE_OUT, ${JSON.stringify(identity)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n`,
      { mode: 0o755 },
    );
    symlinkSync(
      join('..', PROBE_PACKAGE, 'cli.js'),
      join(root, 'node_modules', '.bin', PROBE_PACKAGE),
    );
  }

  function hostileProject(root: string): string {
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'hostile',
        private: true,
        dependencies: { [PROBE_PACKAGE]: '1.0.0' },
      }),
    );
    plantProbe(project, 'project');
    const shell = join(project, 'planted-shell.sh');
    writeFileSync(shell, '#!/bin/sh\necho npmrc >> "$OK_PROBE_OUT"\nexec /bin/sh "$@"\n', {
      mode: 0o755,
    });
    writeFileSync(join(project, '.npmrc'), `script-shell=${shell}\n`);
    return project;
  }

  function isolatedPrefix(root: string): string {
    const prefix = join(root, 'isolated');
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'package.json'), '{"private":true}');
    plantProbe(prefix, 'isolated');
    return prefix;
  }

  function runLaunch(command: string, args: readonly string[], cwd: string, root: string) {
    const out = join(root, 'probe.out');
    const userConfig = join(root, 'user-npmrc');
    const globalConfig = join(root, 'global-npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    const result = spawnSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        OK_PROBE_OUT: out,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_cache: join(root, 'npm-cache'),
        npm_config_offline: 'true',
        npm_config_update_notifier: 'false',
      },
    });
    return { result, ran: existsSync(out) ? readFileSync(out, 'utf8') : '' };
  }

  const probeArgs = (args: readonly string[]) =>
    args.map((arg) => (arg === AGENT_BROWSER_MCP_PACKAGE ? `${PROBE_PACKAGE}@1.0.0` : arg));

  test("never runs the project's own npm packages or reads its .npmrc", () => {
    const npx = resolveOnPath('npx', process.env.PATH);
    if (npx === null) return;
    const root = tmp();
    const project = hostileProject(root);
    const prefix = isolatedPrefix(root);
    const files = join(root, 'files');
    const server = agentBrowserMcpServer({
      npx: { npx, path: process.env.PATH ?? '' },
      folders: { npm: prefix, files },
      env: { DISPLAY: ':0' },
    });
    if (server === null) throw new Error('no server');
    const { result, ran } = runLaunch(server.command, probeArgs(server.args), project, root);
    expect(result.status, result.stderr).toBe(0);
    expect(ran).toBe(
      `isolated --isolated --no-webmcp --output-dir ${files} --file-paths absolute\n`,
    );
  }, 90_000);
});

describe('resolveBrowserNpx', () => {
  test('takes the first PATH whose npx is accepted and skips empty candidates', () => {
    const seen: string[] = [];
    const resolved = resolveBrowserNpx(
      [undefined, null, '', '/agent/bin', '/project/bin', '/login/bin'],
      (name, path) => {
        seen.push(`${name}@${path}`);
        return path === '/agent/bin' ? null : `${path}/npx`;
      },
      (npx) => npx !== '/project/bin/npx',
    );
    expect(resolved).toEqual({ npx: '/login/bin/npx', path: '/login/bin' });
    expect(seen).toEqual(['npx@/agent/bin', 'npx@/project/bin', 'npx@/login/bin']);
    expect(resolveBrowserNpx(['/nowhere'], () => null)).toBeNull();
  });
});

describe('browserNpxRunnable', () => {
  test("needs the node that ships beside npx, and on Windows npm's own files too", () => {
    const npx = join('C:', 'shims', 'npx');
    expect(browserNpxRunnable(npx, { platform: 'darwin', exists: () => false })).toBe(false);
    expect(browserNpxRunnable(npx, { platform: 'darwin', exists: () => true })).toBe(true);
    expect(browserNpxRunnable(npx, { platform: 'win32', exists: () => false })).toBe(false);
    expect(
      browserNpxRunnable(npx, { platform: 'win32', exists: (path) => path.endsWith('node.exe') }),
    ).toBe(false);
    expect(browserNpxRunnable(npx, { platform: 'win32', exists: () => true })).toBe(true);
  });
});

describe('browser folders', () => {
  test('are private to the user, keep saved files across launches, and rebuild only the npm folder', async () => {
    const root = tmp();
    const first = await prepareAgentBrowserFolders(root, THREAD);
    expect(first).toEqual({
      npm: join(root, 'agent-browser', THREAD, 'npm'),
      files: join(root, 'agent-browser', THREAD, 'files'),
    });
    if (process.platform !== 'win32') {
      for (const dir of [
        join(root, 'agent-browser'),
        join(root, 'agent-browser', THREAD),
        first.npm,
        first.files,
      ]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    }
    writeFileSync(join(first.npm, '.npmrc'), 'script-shell=/tmp/planted.sh\n');
    mkdirSync(join(first.npm, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(first.npm, 'package.json'), '{"name":"planted","workspaces":["x"]}');
    writeFileSync(join(first.files, 'page.png'), 'x');

    const second = await prepareAgentBrowserFolders(root, THREAD);
    expect(second).toEqual(first);
    expect(existsSync(join(second.npm, '.npmrc'))).toBe(false);
    expect(existsSync(join(second.npm, 'node_modules'))).toBe(false);
    expect(JSON.parse(readFileSync(join(second.npm, 'package.json'), 'utf8'))).toEqual({
      name: 'openknowledge-agent-browser',
      version: '0.0.0',
      private: true,
    });
    expect(readFileSync(join(second.files, 'page.png'), 'utf8')).toBe('x');

    await removeAgentBrowserFolders(root, THREAD);
    expect(existsSync(join(root, 'agent-browser', THREAD))).toBe(false);
    expect(existsSync(join(root, 'agent-browser'))).toBe(true);
    await removeAgentBrowserFolders(root, '0b1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
  });

  test('refuse chat ids OpenKnowledge did not mint, so nothing outside a chat folder is touched', async () => {
    const parent = tmp();
    const root = join(parent, 'global');
    const other = join(root, 'agent-browser', THREAD, 'files');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'shot.png'), 'x');
    writeFileSync(join(parent, 'keep.txt'), 'x');
    for (const id of ['', '.', '..', '../..', `${THREAD}/..`, 'thread-1', `../${THREAD}`]) {
      await expect(prepareAgentBrowserFolders(root, id)).rejects.toThrow();
      await removeAgentBrowserFolders(root, id);
    }
    expect(existsSync(join(other, 'shot.png'))).toBe(true);
    expect(existsSync(join(parent, 'keep.txt'))).toBe(true);
  });
});
