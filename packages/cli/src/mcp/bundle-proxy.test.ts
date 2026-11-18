import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { bundleEntryFor, bundleWrapperFor } from './bundle-identity.ts';
import {
  emitBundleProxyEvent,
  findBundledOkPath,
  proxyToBundle,
  shouldProxyToBundle,
} from './bundle-proxy.ts';

const userBundle = '/Users/alice/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
const systemBundle = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
const userBetaBundle =
  '/Users/alice/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh';
const systemBetaBundle = '/Applications/OpenKnowledge Beta.app/Contents/Resources/cli/bin/ok.sh';

describe('findBundledOkPath', () => {
  test('returns the user-local bundle before /Applications', () => {
    const seen = new Set([userBundle, systemBundle]);
    expect(findBundledOkPath('darwin', '/Users/alice', { existsSync: (p) => seen.has(p) })).toBe(
      userBundle,
    );
  });

  test('returns the system bundle when it is the only candidate', () => {
    expect(
      findBundledOkPath('darwin', '/Users/alice', { existsSync: (p) => p === systemBundle }),
    ).toBe(systemBundle);
  });

  test('returns Beta from user or system Applications when Stable is absent', () => {
    expect(
      findBundledOkPath('darwin', '/Users/alice', {
        existsSync: (p) => p === userBetaBundle,
      }),
    ).toBe(userBetaBundle);
    expect(
      findBundledOkPath('darwin', '/Users/alice', {
        existsSync: (p) => p === systemBetaBundle,
      }),
    ).toBe(systemBetaBundle);
  });

  test('prefers Stable across install locations when both products exist', () => {
    const seen = new Set([systemBundle, userBetaBundle]);
    expect(findBundledOkPath('darwin', '/Users/alice', { existsSync: (p) => seen.has(p) })).toBe(
      systemBundle,
    );
  });

  test('returns null for absent bundles and non-macOS platforms', () => {
    expect(findBundledOkPath('darwin', '/Users/alice', { existsSync: () => false })).toBeNull();
    expect(findBundledOkPath('linux', '/Users/alice', { existsSync: () => true })).toBeNull();
  });
});

describe('shouldProxyToBundle', () => {
  test('suppresses via env, flag, platform, and bundled self detection', () => {
    expect(
      shouldProxyToBundle({ OK_BUNDLE_PROXY: '0' }, ['node', 'cli.mjs', 'mcp'], 'darwin'),
    ).toEqual({
      proxy: false,
      suppressedBy: 'env',
    });
    expect(
      shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp', '--no-bundle-proxy'], 'darwin'),
    ).toEqual({
      proxy: false,
      suppressedBy: 'flag',
    });
    expect(shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp'], 'linux')).toEqual({
      proxy: false,
      suppressedBy: 'platform',
    });
    expect(
      shouldProxyToBundle(
        {},
        ['node', '/Applications/OpenKnowledge.app/Contents/Resources/cli/dist/cli.mjs', 'mcp'],
        'darwin',
      ),
    ).toEqual({ proxy: false, suppressedBy: 'self' });
  });

  test('proxies on macOS when no suppression signal is present', () => {
    expect(shouldProxyToBundle({}, ['node', 'cli.mjs', 'mcp'], 'darwin')).toEqual({
      proxy: true,
      suppressedBy: null,
    });
  });
});

describe('emitBundleProxyEvent', () => {
  test('emits a parseable JSON line with the suppression hint as a field', () => {
    let stderr = '';
    emitBundleProxyEvent({
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
      mode: 'fallback-absent',
      bundlePath: null,
      reason: 'no bundle',
    });

    const parsed = JSON.parse(stderr);
    expect(parsed).toMatchObject({
      event: 'mcp-bundle-proxy',
      mode: 'fallback-absent',
      bundlePath: null,
      reason: 'no bundle',
    });
    expect(parsed.hint).toContain('--no-bundle-proxy');
  });
});

function packageRootOf(dir: string): string {
  return existsSync(join(dir, 'package.json')) ? dir : packageRootOf(dirname(dir));
}

const PACKAGE_ROOT = packageRootOf(import.meta.dirname);
const CLI_SOURCE_URL = pathToFileURL(join(PACKAGE_ROOT, 'src/cli.ts')).href;
const CLI_ENTRY_PATH_SOURCE_URL = pathToFileURL(join(PACKAGE_ROOT, 'src/cli-entry-path.ts')).href;
const TSX_IMPORT_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const WATCH_INTERVAL_MS = 100;
const PRODUCTION_WATCH_INTERVAL_MS = 5 * 60 * 1000;
const TAKEOVER_LINE = "the new bundle's MCP server took over this session";
const UPDATED_MID_REQUEST = 'OpenKnowledge was updated while this request was running';

const runAsMacWithFastBundleWatch = [
  "Object.defineProperty(process, 'platform', { value: 'darwin' });",
  'const realSetInterval = globalThis.setInterval;',
  `globalThis.setInterval = (fn, ms, ...rest) => realSetInterval(fn, ms === ${PRODUCTION_WATCH_INTERVAL_MS} ? ${WATCH_INTERVAL_MS} : ms, ...rest);`,
].join('\n');

function realCliEntry(recordEntry: boolean): string {
  return [
    runAsMacWithFastBundleWatch,
    ...(recordEntry
      ? [
          `const { recordCliEntryPath } = await import(${JSON.stringify(CLI_ENTRY_PATH_SOURCE_URL)});`,
          'recordCliEntryPath(import.meta.url);',
        ]
      : []),
    `await import(${JSON.stringify(CLI_SOURCE_URL)});`,
    '',
  ].join('\n');
}

function fakeServer(version: string, protocolVersion?: string): string {
  return [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    `const version = ${JSON.stringify(version)};`,
    `const protocolOverride = ${JSON.stringify(protocolVersion ?? null)};`,
    'let initialized = false;',
    "let client = 'none';",
    'const awaiting = new Map();',
    "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });",
    "  const text = (value) => reply({ content: [{ type: 'text', text: value }] });",
    "  if (message.method === 'tools/call' && typeof message.params.arguments.cwd === 'string') {",
    "    send({ jsonrpc: '2.0', method: 'notifications/openknowledge/handover-state', params: { state: { stickyProjectDir: message.params.arguments.cwd } } });",
    '  }',
    "  if (!('method' in message)) {",
    '    awaiting.get(message.id)?.(message);',
    "  } else if (message.method === 'notifications/cancelled') {",
    "    if (process.env.FAKE_CANCEL_LOG) appendFileSync(process.env.FAKE_CANCEL_LOG, version + ' ' + message.params.requestId + '\\n');",
    '    awaiting.get(message.params.requestId)?.({ cancelledAs: message.params.requestId });',
    "  } else if (message.method === 'initialize') {",
    '    client = message.params.clientInfo.name;',
    "    reply({ protocolVersion: protocolOverride ?? message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-bundle', version } });",
    "  } else if (message.method === 'notifications/initialized') {",
    '    initialized = true;',
    "  } else if (message.method === 'tools/list') {",
    "    reply({ tools: ['whoami', 'sleep', 'hold', 'ask', 'give-up', 'handover-env', 'mark', 'crash'].map((name) => ({ name, inputSchema: { type: 'object' } })) });",
    "  } else if (message.method === 'tools/call' && message.params.name === 'whoami') {",
    "    text(version + ' client=' + client + ' initialized=' + initialized + ' relayed=' + (process.env.OK_MCP_BUNDLE_RELAY ?? 'unset'));",
    "  } else if (message.method === 'tools/call' && message.params.name === 'handover-env') {",
    "    text(version + ' state=' + (process.env.OK_MCP_HANDOVER_STATE ?? 'unset'));",
    "  } else if (message.method === 'tools/call' && message.params.name === 'mark') {",
    '    writeFileSync(message.params.arguments.path, version);',
    "    text(version + ' marked');",
    "  } else if (message.method === 'tools/call' && message.params.name === 'sleep') {",
    "    setTimeout(() => text(version + ' slept'), message.params.arguments.ms);",
    "  } else if (message.method === 'tools/call' && message.params.name === 'hold') {",
    "    const poll = setInterval(() => { if (existsSync(message.params.arguments.release)) { clearInterval(poll); text(version + ' released'); } }, 20);",
    "  } else if (message.method === 'tools/call' && message.params.name === 'ask') {",
    "    awaiting.set(0, (answer) => text(answer.result ? version + ' roots=' + answer.result.roots.length : version + ' cancelled=' + answer.cancelledAs));",
    "    send({ jsonrpc: '2.0', id: 0, method: 'roots/list' });",
    "  } else if (message.method === 'tools/call' && message.params.name === 'give-up') {",
    "    send({ jsonrpc: '2.0', id: 1, method: 'roots/list' });",
    "    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'timed out' } });",
    "    text(version + ' gave up');",
    "  } else if (message.method === 'tools/call' && message.params.name === 'crash') {",
    '    process.exit(2);',
    "  } else if ('id' in message) {",
    "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });",
    '  }',
    '});',
    "lines.on('close', () => process.exit(0));",
    '',
  ].join('\n');
}

interface FakeBundle {
  readonly root: string;
  readonly okPath: string;
  readonly cliPath: string;
  replaceCli(source: string): void;
}

const scratchDirs: string[] = [];
const runningProxies: Array<{ hostIn: PassThrough; settled: Promise<unknown> }> = [];
const PROXY_STOP_BOUND_MS = 15_000;

afterEach(async () => {
  for (const proxy of runningProxies.splice(0)) {
    proxy.hostIn.end();
    await Promise.race([
      proxy.settled,
      new Promise((resolveBound) => setTimeout(resolveBound, PROXY_STOP_BOUND_MS).unref()),
    ]);
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBundle(cliSource: string): FakeBundle {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-bundle-handover-')));
  scratchDirs.push(root);
  const resources = join(root, 'Applications/OpenKnowledge.app/Contents/Resources/cli');
  mkdirSync(join(resources, 'bin'), { recursive: true });
  mkdirSync(join(resources, 'dist'), { recursive: true });
  const okPath = join(resources, 'bin/ok.sh');
  const cliPath = join(resources, 'dist/cli.mjs');
  writeFileSync(
    okPath,
    [
      '#!/bin/sh',
      `${JSON.stringify(process.execPath)} --import ${TSX_IMPORT_URL} --conditions=development "$(dirname "$0")/../dist/cli.mjs" "$@"`,
      'exit $?',
      '',
    ].join('\n'),
  );
  chmodSync(okPath, 0o755);
  writeFileSync(cliPath, cliSource);
  return {
    root,
    okPath,
    cliPath,
    replaceCli: (source) => {
      const next = `${cliPath}.next`;
      writeFileSync(next, source);
      renameSync(next, cliPath);
    },
  };
}

function hostEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    DO_NOT_TRACK: '1',
    OK_MCP_AUTOSTART: '0',
    OPENKNOWLEDGE_MCP_AUTOSTART: '0',
  };
}

function makeProject(dir: string): string {
  for (const configDir of ['.ok', '.open-knowledge']) {
    mkdirSync(join(dir, configDir), { recursive: true });
    writeFileSync(join(dir, configDir, 'config.yml'), '{}\n');
  }
  return dir;
}

function watchStderr(transport: StdioClientTransport) {
  let text = '';
  let closed = false;
  const waiters: Array<() => void> = [];
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  transport.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    wake();
  });
  transport.onclose = () => {
    closed = true;
    wake();
  };
  const settled = async (needle: string): Promise<void> => {
    while (!text.includes(needle) && !closed) {
      await new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter));
    }
  };
  return { settled, text: () => text, closed: () => closed };
}

async function whoami(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first?.text ?? '';
}

describe('an MCP stdio session survives a bundle replacement', () => {
  test.each([
    {
      entry: 'the npm ok mcp, which proxies to the app bundle',
      command: (bundle: FakeBundle, launcher: string) => [
        '--import',
        TSX_IMPORT_URL,
        '--conditions=development',
        launcher,
        '--cwd',
        bundle.root,
        '--log-level',
        'silent',
        'mcp',
      ],
    },
    {
      entry: "the app bundle's own ok mcp",
      command: (bundle: FakeBundle) => [
        bundle.okPath,
        '--cwd',
        bundle.root,
        '--log-level',
        'silent',
        'mcp',
      ],
    },
  ])(
    'a host that launched $entry keeps its session and reaches the new bundle without reconnecting',
    async ({ command }) => {
      const bundle = makeBundle(realCliEntry(true));
      const launcher = join(bundle.root, 'npm-ok.mjs');
      writeFileSync(launcher, realCliEntry(false));
      const args = command(bundle, launcher);
      const transport = new StdioClientTransport({
        command: args[0] === '--import' ? process.execPath : '/bin/sh',
        args,
        cwd: PACKAGE_ROOT,
        env: hostEnv(bundle.root),
        stderr: 'pipe',
      });
      const stderr = watchStderr(transport);
      const client = new Client({ name: 'handover-host', version: '1.0.0' });
      let toolListChanged = false;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        toolListChanged = true;
      });
      try {
        await client.connect(transport);
        const before = await client.listTools();
        expect(before.tools.map((tool) => tool.name)).toContain('write');
        expect(client.getServerVersion()?.name).not.toBe('fake-bundle');
        const project = makeProject(join(bundle.root, 'project'));
        await client.callTool({
          name: 'write',
          arguments: { cwd: project, document: { path: 'draft', content: '# Draft\n' } },
        });

        bundle.replaceCli(fakeServer('v2'));
        await stderr.settled(TAKEOVER_LINE);

        const answer = await whoami(client).catch(
          (err: unknown) => `whoami failed: ${String(err)}`,
        );
        expect(answer, stderr.text()).toBe('v2 client=handover-host initialized=true relayed=1');
        expect(toolListChanged).toBe(true);
        const handedOver = await client.callTool({ name: 'handover-env', arguments: {} });
        expect(handedOver.content).toEqual([
          { type: 'text', text: `v2 state=${JSON.stringify({ stickyProjectDir: project })}` },
        ]);
        expect(stderr.closed()).toBe(false);
      } finally {
        await client.close();
      }
    },
    90_000,
  );
});

test('a relayed ok mcp routes calls without cwd to the directory the previous server had stuck to', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-relayed-mcp-')));
  scratchDirs.push(root);
  const handedOverDir = join(root, 'moved-away');
  mkdirSync(handedOverDir);
  const entry = join(root, 'ok.mjs');
  writeFileSync(entry, realCliEntry(false));
  const callWithoutCwd = async (handedOverCwd: string | undefined): Promise<string> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        TSX_IMPORT_URL,
        '--conditions=development',
        entry,
        '--cwd',
        root,
        '--log-level',
        'silent',
        'mcp',
      ],
      cwd: PACKAGE_ROOT,
      env: {
        ...hostEnv(root),
        OK_MCP_BUNDLE_RELAY: '1',
        ...(handedOverCwd === undefined
          ? {}
          : { OK_MCP_HANDOVER_STATE: JSON.stringify({ stickyProjectDir: handedOverCwd }) }),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'relay', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'write',
        arguments: { document: { path: 'draft', content: '# Draft\n' } },
      });
      return JSON.stringify(result.content);
    } finally {
      await client.close();
    }
  };

  expect(await callWithoutCwd(undefined)).toContain('`cwd` is required');
  const handedOver = await callWithoutCwd(handedOverDir);
  expect(handedOver).not.toContain('`cwd` is required');
  expect(handedOver).toContain(`at or above ${handedOverDir}`);
}, 90_000);

test('an in-process ok mcp outside an app bundle hands over to its new entry file and exits with its status', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-npm-handover-')));
  scratchDirs.push(root);
  const entry = join(root, 'npm', 'dist', 'cli.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, realCliEntry(true));
  const host = lineHost();
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_IMPORT_URL,
      '--conditions=development',
      entry,
      '--cwd',
      root,
      '--log-level',
      'silent',
      'mcp',
      '--no-bundle-proxy',
    ],
    { cwd: PACKAGE_ROOT, env: hostEnv(root), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<number | null>((resolveExit) =>
    child.once('close', (code) => {
      host.failWaits(`ok mcp exited with code ${code}`);
      resolveExit(code);
    }),
  );
  host.hostIn.pipe(child.stdin);
  child.stdout.pipe(host.hostOut);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => host.stderr.write(chunk));
  try {
    await initialize(host);
    const before = (await host.request(1, 'tools/list')) as { result?: { tools: unknown[] } };
    expect(before.result?.tools.length).toBeGreaterThan(1);

    const next = `${entry}.next`;
    writeFileSync(next, fakeServer('v2'));
    renameSync(next, entry);
    await host.untilStderr(TAKEOVER_LINE);

    expect(textOf(await host.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );
    void host.request(3, 'tools/call', { name: 'crash', arguments: {} }).catch(() => undefined);
    expect(await exited).toBe(2);
  } finally {
    host.hostIn.end();
    await exited;
  }
}, 90_000);

interface HostMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface LineHost {
  readonly hostIn: PassThrough;
  readonly hostOut: PassThrough;
  readonly stderrText: () => string;
  readonly stderr: { write: (chunk: string) => boolean };
  readonly received: HostMessage[];
  request(id: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  respond(id: string | number, result: Record<string, unknown>): void;
  notify(method: string, params?: Record<string, unknown>): void;
  untilStderr(needle: string): Promise<void>;
  untilServerRequest(method: string): Promise<HostMessage>;
  failWaits(reason: string): void;
}

function lineHost(): LineHost {
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const received: HostMessage[] = [];
  const answers = new Map<number, PromiseWithResolvers<unknown>>();
  const waiters = new Set<PromiseWithResolvers<void>>();
  let stderrText = '';
  let failure: Error | undefined;
  let buffered = '';
  const wake = (): void => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const nextChange = (): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure);
    const waiter = Promise.withResolvers<void>();
    waiters.add(waiter);
    return waiter.promise;
  };
  hostOut.setEncoding('utf8');
  hostOut.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const message = JSON.parse(buffered.slice(0, newline)) as HostMessage;
      buffered = buffered.slice(newline + 1);
      received.push(message);
      if (message.method === undefined && typeof message.id === 'number') {
        answers.get(message.id)?.resolve(message);
      }
      newline = buffered.indexOf('\n');
    }
    wake();
  });
  const write = (message: Record<string, unknown>): void => {
    hostIn.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  return {
    hostIn,
    hostOut,
    received,
    stderrText: () => stderrText,
    stderr: {
      write: (chunk: string) => {
        stderrText += chunk;
        wake();
        return true;
      },
    },
    request: (id, method, params = {}) => {
      const answer = Promise.withResolvers<unknown>();
      if (failure !== undefined) answer.reject(failure);
      answers.set(id, answer);
      write({ id, method, params });
      return answer.promise;
    },
    respond: (id, result) => write({ id, result }),
    notify: (method, params) => write(params === undefined ? { method } : { method, params }),
    untilStderr: async (needle) => {
      while (!stderrText.includes(needle)) await nextChange();
    },
    untilServerRequest: async (method) => {
      while (true) {
        const request = received.find((message) => message.method === method && 'id' in message);
        if (request !== undefined) return request;
        await nextChange();
      }
    },
    failWaits: (reason) => {
      failure = new Error(`${reason}\nrelay stderr:\n${stderrText}`);
      for (const answer of answers.values()) answer.reject(failure);
      for (const waiter of waiters) waiter.reject(failure);
      waiters.clear();
    },
  };
}

async function initialize(host: LineHost, protocolVersion = '2025-06-18'): Promise<void> {
  await host.request(0, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'line-host', version: '1.0.0' },
  });
  host.notify('notifications/initialized');
}

function startProxy(
  bundle: FakeBundle,
  host: LineHost,
  extra: Partial<Parameters<typeof proxyToBundle>[0]> = {},
) {
  const { promise: exited, resolve: exitWith } = Promise.withResolvers<number>();
  const proxied = proxyToBundle({
    bundlePath: bundle.okPath,
    argv: ['mcp'],
    env: { PATH: process.env.PATH ?? '', FAKE_CANCEL_LOG: join(bundle.root, 'cancelled.log') },
    stderr: host.stderr,
    hostIn: host.hostIn,
    hostOut: host.hostOut,
    signals: new EventEmitter(),
    platform: 'darwin',
    watchIntervalMs: WATCH_INTERVAL_MS,
    spawnImpl: ((command: string, args: readonly string[], options: object) =>
      spawn(command, args, { ...options, cwd: PACKAGE_ROOT })) as never,
    exitProcess: ((code: number) => {
      host.failWaits(`the relay exited with code ${code}`);
      exitWith(code);
      return undefined as never;
    }) as never,
    ...extra,
  });
  runningProxies.push({
    hostIn: host.hostIn,
    settled: Promise.race([exited, proxied.catch(() => undefined)]),
  });
  return { proxied, exited };
}

async function fileContents(path: string, boundMs = 10_000): Promise<string> {
  const deadline = Date.now() + boundMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} was not written within ${boundMs}ms`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  return readFileSync(path, 'utf8');
}

function textOf(message: unknown): string {
  const result = (message as { result?: { content?: Array<{ text: string }> } }).result;
  return result?.content?.[0]?.text ?? JSON.stringify(message);
}

const V2_WHOAMI = 'v2 client=line-host initialized=true relayed=1';

describe('proxyToBundle', () => {
  test('lets a request in flight at the replacement finish on the old server, then serves the next one from the new bundle', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);
    const release = join(bundle.root, 'release');

    const inFlight = host.request(1, 'tools/call', { name: 'hold', arguments: { release } });
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr('once 1 in-flight request(s) finish');
    const next = host.request(2, 'tools/call', { name: 'whoami', arguments: {} });
    writeFileSync(release, '');

    expect(textOf(await inFlight)).toBe('v1 released');
    expect(textOf(await next)).toBe(V2_WHOAMI);
    expect(host.received.map((message) => message.method)).toContain(
      'notifications/tools/list_changed',
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test("delivers the host's answer to the old server's own request while that server drains", async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);

    const asking = host.request(1, 'tools/call', { name: 'ask', arguments: {} });
    const rootsRequest = await host.untilServerRequest('roots/list');
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr('once 1 in-flight request(s) finish');
    host.respond(rootsRequest.id ?? 'missing', { roots: [{ uri: 'file:///work' }] });

    expect(textOf(await asking)).toBe('v1 roots=1');
    expect(textOf(await host.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('stops waiting for a request the host cancels while the old server drains', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);

    void host
      .request(1, 'tools/call', {
        name: 'hold',
        arguments: { release: join(bundle.root, 'never') },
      })
      .catch(() => undefined);
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr('once 1 in-flight request(s) finish');
    host.notify('notifications/cancelled', { requestId: 1 });

    expect(textOf(await host.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );
    expect(host.received.filter((message) => message.id === 1)).toEqual([]);

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('keeps the session protocol version when the new server supports a newer one the host asked for', async () => {
    const bundle = makeBundle(fakeServer('v1', '2025-06-18'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host, '2025-11-25');

    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr(TAKEOVER_LINE);

    expect(textOf(await host.request(1, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test("translates cancellations of the server's own requests in both directions", async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);

    const asking = host.request(1, 'tools/call', { name: 'ask', arguments: {} });
    const rootsRequest = await host.untilServerRequest('roots/list');
    host.notify('notifications/cancelled', { requestId: rootsRequest.id });
    expect(textOf(await asking)).toBe('v1 cancelled=0');

    await host.request(2, 'tools/call', { name: 'give-up', arguments: {} });
    const givenUp = host.received.filter((message) => message.method === 'roots/list').at(-1);
    const cancel = host.received.find((message) => message.method === 'notifications/cancelled');
    expect(givenUp?.id).not.toBe(rootsRequest.id);
    expect(cancel?.params?.requestId).toBe(givenUp?.id);

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('drops a request the host cancels while it waits for the new server, and answers pings meanwhile', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);
    const release = join(bundle.root, 'release');
    const marker = join(bundle.root, 'marked');

    const inFlight = host.request(1, 'tools/call', { name: 'hold', arguments: { release } });
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr('once 1 in-flight request(s) finish');
    void host
      .request(2, 'tools/call', { name: 'mark', arguments: { path: marker } })
      .catch(() => undefined);
    host.notify('notifications/cancelled', { requestId: 2 });
    expect(await host.request(3, 'ping')).toMatchObject({ id: 3, result: {} });
    writeFileSync(release, '');

    expect(textOf(await inFlight)).toBe('v1 released');
    expect(textOf(await host.request(4, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );
    expect(existsSync(marker)).toBe(false);
    expect(host.received.filter((message) => message.id === 2)).toEqual([]);

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('gives the new server the project the session last named with an explicit cwd', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);

    await host.request(1, 'tools/call', { name: 'whoami', arguments: { cwd: '/work/tree' } });
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr(TAKEOVER_LINE);

    expect(
      textOf(await host.request(2, 'tools/call', { name: 'handover-env', arguments: {} })),
    ).toBe('v2 state={"stickyProjectDir":"/work/tree"}');
    expect(host.received.map((message) => message.method)).not.toContain(
      'notifications/openknowledge/handover-state',
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('answers a request the old server could not finish in time with an MCP error instead of dropping it', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host, { drainTimeoutMs: 200 });
    await initialize(host);

    const stuck = host.request(1, 'tools/call', { name: 'sleep', arguments: { ms: 600_000 } });
    bundle.replaceCli(fakeServer('v2'));
    await host.untilStderr('handing this MCP session');
    const next = host.request(2, 'tools/call', { name: 'whoami', arguments: {} });

    expect(await stuck).toMatchObject({
      id: 1,
      error: { message: expect.stringContaining(UPDATED_MID_REQUEST) },
    });
    expect(textOf(await next)).toBe(V2_WHOAMI);
    expect(host.stderrText()).toContain('answered 1 request(s) the old server did not finish');
    expect(await fileContents(join(bundle.root, 'cancelled.log'))).toBe('v1 1\n');

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('hands over when an older bundle server exits on its own after the replacement', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host, { watchIntervalMs: 600_000 });
    await initialize(host);

    bundle.replaceCli(fakeServer('v2'));
    const crashed = host.request(1, 'tools/call', { name: 'crash', arguments: {} });

    expect(await crashed).toMatchObject({
      id: 1,
      error: { message: expect.stringContaining(UPDATED_MID_REQUEST) },
    });
    expect(textOf(await host.request(2, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test('retries the new bundle while it is still being copied into place', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host, { retryDelaysMs: [50] });
    await initialize(host);

    bundle.replaceCli('process.exit(3);\n');
    await host.untilStderr("the new bundle's MCP server did not start: exited with code 3");
    bundle.replaceCli(fakeServer('v2'));

    expect(textOf(await host.request(1, 'tools/call', { name: 'whoami', arguments: {} }))).toBe(
      V2_WHOAMI,
    );

    host.hostIn.end();
    expect(await exited).toBe(0);
  });

  test.each([
    { newBundle: 'process.exit(3);\n', reason: 'exited with code 3' },
    {
      newBundle: fakeServer('v2', '2024-11-05'),
      reason:
        "the new server answered with MCP protocol 2024-11-05 instead of the session's 2025-06-18",
    },
  ])(
    'answers waiting requests with an MCP error and exits 1 when the new bundle $reason',
    async ({ newBundle, reason }) => {
      const bundle = makeBundle(fakeServer('v1'));
      const host = lineHost();
      const { exited } = startProxy(bundle, host, { retryDelaysMs: [] });
      await initialize(host);

      bundle.replaceCli(newBundle);
      await host.untilStderr('handing this MCP session');
      const waiting = host.request(1, 'tools/call', { name: 'whoami', arguments: {} });

      expect(await waiting).toMatchObject({
        id: 1,
        error: {
          message: expect.stringContaining(`its new MCP server could not start (${reason})`),
        },
      });
      expect(await exited).toBe(1);
    },
  );

  test('exits with the established server exit code when the bundle was not replaced', async () => {
    const bundle = makeBundle(fakeServer('v1'));
    const host = lineHost();
    const { exited } = startProxy(bundle, host);
    await initialize(host);

    void host.request(1, 'tools/call', { name: 'crash', arguments: {} }).catch(() => undefined);

    expect(await exited).toBe(2);
  });

  test('forwards the exit code of a first server that exits after the startup window without answering', async () => {
    const bundle = makeBundle("process.stdin.once('data', () => process.exit(2));\n");
    const host = lineHost();
    let clock = 0;
    const { proxied, exited } = startProxy(bundle, host, {
      now: () => clock,
      startupFailureWindowMs: 1_000,
    });
    let rejected: unknown;
    proxied.catch((err: unknown) => {
      rejected = err;
    });

    clock = 2_000;
    void host.request(0, 'initialize', {}).catch(() => undefined);

    expect(await Promise.race([exited, proxied])).toBe(2);
    expect(rejected).toBeUndefined();
  });

  test('exits with the signal status, not an in-process fallback, when the host stops it with SIGTERM during startup', async () => {
    const bundle = makeBundle('process.stdin.resume();\n');
    const host = lineHost();
    const signals = new EventEmitter();
    const { proxied, exited } = startProxy(bundle, host, {
      signals,
      startupFailureWindowMs: 60_000,
    });
    let rejected: unknown;
    proxied.catch((err: unknown) => {
      rejected = err;
    });
    void host.request(0, 'initialize', {}).catch(() => undefined);

    signals.emit('SIGTERM', 'SIGTERM');

    expect(await Promise.race([exited, proxied])).toBe(143);
    expect(rejected).toBeUndefined();
  });

  test('rejects a startup failure and hands the host input it already read to the in-process fallback', async () => {
    const bundle = makeBundle("process.stdin.once('data', () => process.exit(69));\n");
    const host = lineHost();
    const { proxied } = startProxy(bundle, host, { startupFailureWindowMs: 60_000 });
    const line = (id: number, method: string) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`;
    host.hostIn.write(line(0, 'initialize'));

    await expect(proxied).rejects.toThrow('bundle process exited during startup with code 69');

    const fallback = new StdioServerTransport(host.hostIn, host.hostOut);
    const { promise: bothReceived, resolve: receivedBoth } = Promise.withResolvers<void>();
    const methods: string[] = [];
    fallback.onmessage = (message) => {
      if ('method' in message) methods.push(message.method);
      if (methods.length === 2) receivedBoth();
    };
    await fallback.start();
    host.hostIn.write(line(1, 'tools/list'));
    await bothReceived;
    await fallback.close();

    expect(methods).toEqual(['initialize', 'tools/list']);
  });
});

test('maps between the bundle wrapper and the entry file it runs', () => {
  const entry = '/Applications/OpenKnowledge.app/Contents/Resources/cli/dist/cli.mjs';
  expect(bundleEntryFor(systemBundle)).toBe(entry);
  expect(bundleWrapperFor(entry)).toBe(systemBundle);
  expect(bundleWrapperFor('/usr/local/lib/node_modules/@inkeep/open-knowledge/dist/cli.mjs')).toBe(
    undefined,
  );
});
