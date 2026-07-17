import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAIN_V1,
  CHAIN_WIN_V1,
  isEntryUpToDate,
  PI_EXTENSION_OWNERSHIP_MARKER,
  PI_EXTENSION_VERSION_SENTINEL,
} from '../commands/editors.ts';
import {
  buildPiExtensionSource,
  isOwnPiExtensionSource,
  isOwnPiManagedFileEntry,
  isPiExtensionSourceUpToDate,
  makePiManagedFileEntry,
} from './pi-extension.ts';

describe('buildPiExtensionSource', () => {
  it('published source starts with the version sentinel as its whole first line', () => {
    const source = buildPiExtensionSource();
    expect(source.split('\n')[0]).toBe(PI_EXTENSION_VERSION_SENTINEL);
  });

  it('is byte-deterministic (idempotent ok init re-runs skip the write on equality)', () => {
    expect(buildPiExtensionSource()).toBe(buildPiExtensionSource());
    expect(buildPiExtensionSource({ mode: 'published' })).toBe(buildPiExtensionSource());
  });

  it('embeds BOTH platform launcher chains so one committed file serves every teammate', () => {
    const source = buildPiExtensionSource();
    // The chains ride inside JSON.stringify'd launcher entries, so their
    // newlines appear as the two-character escape.
    expect(source).toContain(JSON.stringify(CHAIN_V1));
    expect(source).toContain(JSON.stringify(CHAIN_WIN_V1));
    expect(source).toContain('process.platform === "win32"');
  });

  it('dev mode embeds the local dist launcher and an owned-but-stale header', () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/packages/cli/src/cli.ts';
    try {
      const source = buildPiExtensionSource({ mode: 'dev' });
      expect(source).toContain('/repo/packages/cli/dist/cli.mjs');
      expect(isOwnPiExtensionSource(source)).toBe(true);
      // Dev drops must NOT classify current, mirroring dev chain entries:
      // the repair/reclaim sweeps migrate them forward to published.
      expect(isPiExtensionSourceUpToDate(source)).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it('generates syntactically valid TypeScript (the file Pi loads via jiti)', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    // Throws on a syntax error — an interpolation regression (unescaped
    // backtick / ${ in the template) fails here rather than inside Pi.
    expect(() => transpiler.transformSync(buildPiExtensionSource())).not.toThrow();
    // Dev-mode source resolves the local dist launcher from argv[1]; the test
    // runner's argv[1] is its own worker, so stub a CLI-shaped path (as the
    // sibling dev-mode test does) to let repo-root inference succeed.
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/packages/cli/src/cli.ts';
    try {
      expect(() => transpiler.transformSync(buildPiExtensionSource({ mode: 'dev' }))).not.toThrow();
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it('registers under the ok_ prefix so OK tools never shadow Pi built-ins', () => {
    // Pi has no MCP namespacing; an unprefixed `edit` / `write` registration
    // would OVERRIDE Pi's built-in file tools.
    expect(buildPiExtensionSource()).toContain('const TOOL_PREFIX = "ok_"');
  });
});

describe('pi extension recognizers', () => {
  const published = buildPiExtensionSource();

  it('isOwnPiExtensionSource: first-line strict ownership', () => {
    expect(isOwnPiExtensionSource(published)).toBe(true);
    expect(isOwnPiExtensionSource(`${PI_EXTENSION_OWNERSHIP_MARKER}-v0\nlegacy body`)).toBe(true);
    // Marker in the body only — a foreign file mentioning it is not claimed.
    expect(isOwnPiExtensionSource(`// my extension\n${PI_EXTENSION_OWNERSHIP_MARKER}\n`)).toBe(
      false,
    );
    expect(isOwnPiExtensionSource('export default function () {}')).toBe(false);
  });

  it('isPiExtensionSourceUpToDate: current version only', () => {
    expect(isPiExtensionSourceUpToDate(published)).toBe(true);
    expect(isPiExtensionSourceUpToDate(`${PI_EXTENSION_OWNERSHIP_MARKER}-v0\nstale`)).toBe(false);
    expect(isPiExtensionSourceUpToDate('// something else')).toBe(false);
  });

  it('isEntryUpToDate recognizes the synthetic managed-file entry', () => {
    expect(isEntryUpToDate(makePiManagedFileEntry(published))).toBe(true);
    expect(isEntryUpToDate(makePiManagedFileEntry(`${PI_EXTENSION_OWNERSHIP_MARKER}-v0\nx`))).toBe(
      false,
    );
    expect(isEntryUpToDate(makePiManagedFileEntry('foreign'))).toBe(false);
  });

  it('isOwnPiManagedFileEntry gates removal on the ownership marker', () => {
    expect(isOwnPiManagedFileEntry(makePiManagedFileEntry(published))).toBe(true);
    expect(
      isOwnPiManagedFileEntry(makePiManagedFileEntry(`${PI_EXTENSION_OWNERSHIP_MARKER}-v0\nx`)),
    ).toBe(true);
    expect(isOwnPiManagedFileEntry(makePiManagedFileEntry('// foreign file'))).toBe(false);
    expect(isOwnPiManagedFileEntry({ command: '/bin/sh', args: ['-l', '-c', CHAIN_V1] })).toBe(
      false,
    );
    expect(isOwnPiManagedFileEntry(null)).toBe(false);
  });
});

// Functional round-trip: run the GENERATED extension against a fake `pi` API
// and a stub MCP server speaking real newline-delimited JSON-RPC over stdio.
// This exercises the whole bridge — spawn, handshake, tools/list → registerTool,
// execute → tools/call, error mapping — through a real child process, without
// needing Pi or a built OK CLI.
describe('generated bridge extension (functional, stub MCP server)', () => {
  let dir: string;
  const originalArgv1 = process.argv[1];

  const STUB_SERVER = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "stub-ok", version: "0.0.0" },
    }});
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "exec", description: "Run a command.", inputSchema: {
        type: "object", properties: { command: { type: "string" } }, required: ["command"],
      }},
      { name: "boom", description: "Always fails.", inputSchema: { type: "object" } },
    ]}});
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "boom") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: "it broke" }], isError: true,
      }});
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: "ran: " + args.command }],
        structuredContent: { echoed: args.command },
      }});
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-pi-bridge-'));
    // Dev-mode launcher resolves `<root>/packages/cli/dist/cli.mjs` from
    // argv[1]; point it at the stub server so the generated file spawns it.
    mkdirSync(join(dir, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'cli', 'dist', 'cli.mjs'), STUB_SERVER, 'utf-8');
    process.argv[1] = join(dir, 'packages', 'cli', 'src', 'cli.ts');
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    rmSync(dir, { recursive: true, force: true });
  });

  interface RegisteredTool {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
  }

  it('handshakes, registers prefixed tools, forwards calls, maps isError to a throw', async () => {
    const extensionPath = join(dir, 'open-knowledge.ts');
    writeFileSync(extensionPath, buildPiExtensionSource({ mode: 'dev' }), 'utf-8');

    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = new Map<string, RegisteredTool>();
    const fakePi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(event, handler);
      },
      registerTool: (definition: Record<string, unknown>) => {
        const tool = definition as unknown as RegisteredTool;
        tools.set(tool.name, tool);
      },
    };

    const mod = (await import(extensionPath)) as {
      default: (pi: typeof fakePi) => void;
    };
    mod.default(fakePi);
    expect(handlers.has('session_start')).toBe(true);
    expect(handlers.has('session_shutdown')).toBe(true);
    expect(tools.size).toBe(0);

    try {
      await handlers.get('session_start')?.({}, { cwd: dir });

      expect([...tools.keys()].sort()).toEqual(['ok_boom', 'ok_exec']);
      const exec = tools.get('ok_exec');
      expect(exec?.description).toBe('Run a command.');
      // The MCP inputSchema passes through as plain JSON Schema parameters.
      expect(exec?.parameters).toEqual({
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      });

      const result = await exec?.execute('t1', { command: 'ls' }, undefined);
      expect(result?.content).toEqual([{ type: 'text', text: 'ran: ls' }]);
      expect(result?.details).toEqual({ echoed: 'ls' });

      // MCP isError results surface as a throw — Pi's error signal. Await the
      // rejection so it settles before the finally-block shutdown closes the
      // client (an un-awaited assertion races the teardown under vitest).
      await expect(tools.get('ok_boom')?.execute('t2', {}, undefined)).rejects.toThrow('it broke');
    } finally {
      await handlers.get('session_shutdown')?.({}, {});
    }
  }, 20000);
});
