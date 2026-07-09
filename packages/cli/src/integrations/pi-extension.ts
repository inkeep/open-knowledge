/**
 * Pi bridge-extension builder + recognizers.
 *
 * Pi (badlogic's `pi` coding agent) has no MCP support and no MCP config
 * surface at all — its only extension point is a TypeScript extension module
 * auto-discovered from the project's `.pi/extensions/` dir (loaded after the
 * user trusts the folder). OK's integration is therefore a whole managed FILE,
 * not a config entry: `ok init` drops `.pi/extensions/open-knowledge.ts`,
 * whose runtime spawns OK's MCP stdio server through the same resilient
 * launcher every other editor's config embeds (`buildManagedServerEntry`),
 * hand-rolls the newline-delimited JSON-RPC MCP handshake, and registers each
 * MCP tool as a native Pi tool.
 *
 * The generated file must be DEPENDENCY-FREE: Pi loads extensions with jiti
 * and only guarantees Node builtins plus Pi's own bundled modules — a single
 * dropped file cannot rely on npm packages (`@modelcontextprotocol/sdk` is not
 * available). Tool parameter schemas pass through as plain JSON Schema, which
 * Pi's validator accepts alongside TypeBox schemas.
 *
 * Versioning mirrors the chain-entry contract in `commands/editors.ts`:
 * `PI_EXTENSION_VERSION_SENTINEL` on the FIRST LINE is the up-to-date check
 * (reclaim's leave-alone gate) and `PI_EXTENSION_OWNERSHIP_MARKER` — its
 * version-agnostic prefix — is the removal gate. Dev-mode (`--dev-mcp`) files
 * carry the marker but a `-dev` suffix instead of the version sentinel, so
 * sweeps migrate them forward to published exactly like dev chain entries,
 * while removal still recognizes them as OK's own.
 */

import {
  buildManagedServerEntry,
  type McpInstallOptions,
  PI_EXTENSION_OWNERSHIP_MARKER,
  PI_EXTENSION_VERSION_SENTINEL,
  PI_MANAGED_FILE_ENTRY_COMMAND,
} from '../commands/editors.ts';

/** First line of a dev-mode (`--dev-mcp`) drop: owned, never version-current. */
const PI_EXTENSION_DEV_HEADER = `${PI_EXTENSION_OWNERSHIP_MARKER}-dev`;

/**
 * True when raw file text is recognizably OK's own managed Pi extension (any
 * version, including dev drops) — the gate for whole-file removal. First-line
 * strict: a user's own file at the same path that merely mentions the marker
 * somewhere in its body is NOT claimed.
 */
export function isOwnPiExtensionSource(text: string): boolean {
  return text.startsWith(PI_EXTENSION_OWNERSHIP_MARKER);
}

/**
 * True when raw file text carries the CURRENT version sentinel on its first
 * line — the `isEntryUpToDate` equivalent for the managed file. Body drift
 * below line one is tolerated (same leave-alone posture as the chain-entry
 * sentinel check); a stale or dev header fails and triggers a rewrite by the
 * repair/reclaim sweeps.
 */
export function isPiExtensionSourceUpToDate(text: string): boolean {
  return text.startsWith(PI_EXTENSION_VERSION_SENTINEL);
}

/**
 * `isOwnPiExtensionSource` lifted to the synthetic-entry shape — the removal
 * gate consumed by `isRemovableOwnEntry` in `mcp-config-removal.ts`.
 */
export function isOwnPiManagedFileEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.command !== PI_MANAGED_FILE_ENTRY_COMMAND || !Array.isArray(e.args)) return false;
  const text = e.args[0];
  return typeof text === 'string' && isOwnPiExtensionSource(text);
}

/**
 * Wrap raw managed-file text in the synthetic entry shape the shared
 * classify → `isEntryUpToDate` → rewrite/remove machinery consumes.
 * `classifyExistingMcpEntry` synthesizes this for `format: 'file'` targets so
 * every generic consumer (CLI repair sweep, desktop boot + project-open
 * reclaim, surgical removal) flows without per-host branches. `args[0]` is the
 * raw text; telemetry consumers already bound it via `truncatePriorEntry`.
 */
export function makePiManagedFileEntry(text: string): Record<string, unknown> {
  return { command: PI_MANAGED_FILE_ENTRY_COMMAND, args: [text] };
}

/**
 * Build the full contents of `.pi/extensions/open-knowledge.ts`.
 *
 * Byte-deterministic for a given `options` value, so idempotent `ok init`
 * re-runs skip the write on content equality. Published mode embeds BOTH
 * platforms' launcher shapes and picks by `process.platform` at runtime —
 * unlike a static JSON config entry, the dropped file is a program, so one
 * committed artifact serves macOS/Linux and Windows teammates alike. Dev mode
 * (`--dev-mcp`) embeds the machine-local `node dist/cli.mjs mcp` launcher on
 * both slots.
 *
 * The generated source avoids template literals and backticks entirely so the
 * template below never needs escaping gymnastics; launcher shapes are injected
 * as JSON (valid JS expressions by construction).
 */
export function buildPiExtensionSource(options: McpInstallOptions = {}): string {
  const dev = options.mode === 'dev';
  const header = dev ? PI_EXTENSION_DEV_HEADER : PI_EXTENSION_VERSION_SENTINEL;
  const launchers = {
    unix: buildManagedServerEntry({ ...options, platformName: 'darwin' }),
    win32: buildManagedServerEntry({ ...options, platformName: 'win32' }),
  };
  return `${header}
/**
 * Open Knowledge bridge for Pi — MANAGED FILE, written by \`ok init\`.
 * Hand edits are overwritten whenever OK re-syncs this project; remove it
 * with \`ok deinit\` (or delete the file) to disconnect Pi from OK.
 *
 * On session start it spawns Open Knowledge's MCP stdio server via OK's
 * resilient launcher (bundle, then npx, then version-manager probes), performs
 * the MCP handshake, and registers each MCP tool as a Pi tool under an
 * \`ok_\` prefix (Pi has no MCP namespacing; the prefix keeps OK's \`edit\` /
 * \`write\` from shadowing Pi's built-in tools).
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const LAUNCHERS = ${JSON.stringify(launchers, null, 2)} as const;

const TOOL_PREFIX = "ok_";
// First contact may cold-install the CLI through npx — allow a generous window.
const INIT_TIMEOUT_MS = 120000;
const STDERR_TAIL_LIMIT = 2000;

interface McpContentItem {
  type: string;
  text?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

class OkMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  alive = true;

  constructor(cwd: string, onExit: () => void) {
    const launcher = process.platform === "win32" ? LAUNCHERS.win32 : LAUNCHERS.unix;
    const env: Record<string, string | undefined> = { ...process.env };
    const launcherEnv = (launcher as { env?: Record<string, string> }).env;
    if (launcherEnv) Object.assign(env, launcherEnv);
    this.child = spawn(launcher.command, [...launcher.args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Inline (not the withHiddenWindowsConsole helper): this spawn lives in the
      // GENERATED Pi extension source, which must stay dependency-free (Pi loads
      // it with jiti; no npm packages resolve). Hide the console on Windows anyway.
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    // A write buffered before the pipe breaks surfaces as an 'error' on stdin
    // (not on the child); unhandled it would crash Pi's extension host.
    // Swallow it — the exit handler owns teardown.
    this.child.stdin.on("error", () => {});
    const fail = () => {
      if (!this.alive) return;
      this.alive = false;
      const err = new Error(
        "Open Knowledge MCP server exited" +
          (this.stderrTail ? ": " + this.stderrTail.trim() : ""),
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      onExit();
    };
    this.child.on("exit", fail);
    this.child.on("error", fail);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        try {
          this.onMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Non-JSON noise on stdout is ignored; framing recovers on the next line.
        }
      }
      newline = this.buffer.indexOf("\\n");
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof msg.method === "string") {
      // Server-initiated request (e.g. roots/list). This bridge declares no
      // client capabilities, so decline rather than leave the server hanging.
      if (id !== undefined && id !== null) {
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not supported by the OK Pi bridge" },
        });
      }
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = msg.error as { message?: string } | undefined;
    if (error) {
      pending.reject(new Error(error.message || "Open Knowledge MCP error"));
      return;
    }
    pending.resolve((msg.result ?? {}) as Record<string, unknown>);
  }

  private send(msg: Record<string, unknown>): void {
    // Buffered stdout can still dispatch onMessage replies after close() ends
    // stdin; writing then would raise ERR_STREAM_WRITE_AFTER_END unhandled.
    if (!this.alive) return;
    this.child.stdin.write(JSON.stringify(msg) + "\\n");
  }

  request(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error("Open Knowledge MCP server is not running"));
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const done: PendingRequest = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      this.pending.set(id, done);
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          done.reject(new Error(method + " timed out after " + opts.timeoutMs + "ms"));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        onAbort = () => {
          this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
          done.reject(new Error("Cancelled"));
        };
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.alive) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.alive = false;
    for (const p of this.pending.values()) {
      p.reject(new Error("Open Knowledge MCP client closed"));
    }
    this.pending.clear();
    // ok mcp exits on stdin EOF; the delayed kill is a backstop.
    try {
      this.child.stdin.end();
    } catch {
      // Already gone.
    }
    const child = this.child;
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }, 2000).unref();
  }
}

/** JSON Schema pass-through: Pi validates plain JSON Schema parameters. */
function toParameters(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const schema = { ...inputSchema };
  delete schema.$schema;
  return schema;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as McpContentItem[])
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\\n");
}

export default function okBridge(pi: {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(definition: Record<string, unknown>): void;
}) {
  let client: OkMcpClient | null = null;
  let starting: Promise<OkMcpClient> | null = null;
  let sessionCwd = process.cwd();
  const registeredTools = new Set<string>();

  async function ensureClient(): Promise<OkMcpClient> {
    if (client && client.alive) return client;
    if (starting) return starting;
    starting = (async () => {
      const next = new OkMcpClient(sessionCwd, () => {
        if (client === next) client = null;
      });
      try {
        await next.request(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "pi", version: "1.0.0" },
          },
          { timeoutMs: INIT_TIMEOUT_MS },
        );
      } catch (err) {
        // A timed-out initialize rejects the request while the child may
        // still be running; tear it down so retries don't stack orphans.
        next.close();
        throw err;
      }
      next.notify("notifications/initialized", {});
      client = next;
      return next;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function registerOkTools(): Promise<number> {
    const mcp = await ensureClient();
    const listed = await mcp.request("tools/list", {}, { timeoutMs: INIT_TIMEOUT_MS });
    const tools = Array.isArray(listed.tools) ? (listed.tools as McpToolInfo[]) : [];
    for (const tool of tools) {
      const name = TOOL_PREFIX + tool.name;
      if (registeredTools.has(name)) continue;
      registeredTools.add(name);
      pi.registerTool({
        name,
        label: "OK " + tool.name,
        description: tool.description || "Open Knowledge " + tool.name + " tool.",
        parameters: toParameters(tool.inputSchema),
        execute: async (
          _toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
        ) => {
          const live = await ensureClient();
          const result = await live.request(
            "tools/call",
            { name: tool.name, arguments: params ?? {} },
            { signal },
          );
          const text = contentText(result.content);
          if (result.isError) {
            throw new Error(text || "Open Knowledge tool " + tool.name + " failed");
          }
          return {
            content: [{ type: "text", text }],
            details: result.structuredContent,
          };
        },
      });
    }
    return tools.length;
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) sessionCwd = cwd;
    try {
      await registerOkTools();
    } catch (err) {
      const ui = (ctx as { ui?: { notify?: (m: string, level: string) => void } } | undefined)?.ui;
      try {
        ui?.notify?.(
          "Open Knowledge tools unavailable: " + (err instanceof Error ? err.message : String(err)),
          "warning",
        );
      } catch {
        // Non-interactive mode; the failure will resurface on first tool use.
      }
    }
  });

  pi.on("session_shutdown", async () => {
    const pending = starting;
    starting = null;
    const current = client;
    client = null;
    current?.close();
    // An in-flight ensureClient would otherwise assign a live client after
    // shutdown; await it and tear that one down too.
    if (pending) {
      try {
        (await pending).close();
      } catch {
        // Initialization failed — its catch path already closed the client.
      }
    }
  });
}
`;
}
