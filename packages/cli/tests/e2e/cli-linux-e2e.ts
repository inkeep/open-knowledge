/**
 * Black-box end-to-end smoke for the published `@inkeep/open-knowledge` CLI on
 * Linux. Proves the user journey a `npm install -g` user follows — install →
 * init → start (HTTP serve) → MCP stdio round-trip → headless-keyring fallback
 * → teardown — against the **packed tarball running under Node**, which is the
 * only path that exercises npm's native-prebuild resolution (`@napi-rs/keyring`,
 * `@parcel/watcher`) and the package `files` allowlist.
 *
 * NOT auto-discovered by `bun test` — the filename intentionally omits the
 * `.test` / `.e2e` suffix so it never runs inside the unit matrix. It runs only
 * via the explicit `test:e2e:cli` script (and the `cli-e2e` CI job), after a
 * build has produced `packages/cli/dist/`.
 *
 * SUT selection (env `OK_E2E_SUT`):
 *   - `packed` (default) — `npm pack` the CLI, `npm install` the tarball into a
 *     clean prefix under Node, run the installed bin. Full fidelity.
 *   - `workspace` — run the workspace `dist/cli.mjs` under Node directly. Faster
 *     local shake-out; skips tarball + npm prebuild resolution.
 *
 * The harness spawns the CLI with `node` (never `bun`): the published bin's
 * runtime is Node >=24, and running it under Bun would mask Node-specific ESM /
 * native-loader failures.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PKG_DIR = resolve(HERE, '..', '..'); // packages/cli
const WORKSPACE_DIST_CLI = join(CLI_PKG_DIR, 'dist', 'cli.mjs');
const NODE = process.execPath.includes('bun') ? 'node' : process.execPath;
const SUT_MODE = process.env.OK_E2E_SUT === 'workspace' ? 'workspace' : 'packed';
// Hermeticity: suppress the desktop-app bundle proxy so `ok mcp` always routes
// to the server WE booted, never an OK Desktop install that happens to be on
// the dev machine (a no-op on CI Linux, which has no OK.app).
const HERMETIC_ENV = { OK_BUNDLE_PROXY: '0' } as const;
const START_PORT = Number(process.env.OK_E2E_PORT ?? 13581);

interface Harness {
  cliPath: string; // absolute path to cli.mjs to run under node
  binShim: string | null; // installed `.bin/ok` shim (packed mode only)
  installPrefix: string | null; // temp npm prefix (packed mode only)
  packDest: string | null; // temp dir holding the npm pack tarball (packed mode only)
  contentDir: string; // git-backed temp content dir
  lockPath: string; // <contentDir>/.ok/local/server.lock
  server: ChildProcess | null;
}

const H: Harness = {
  cliPath: '',
  binShim: null,
  installPrefix: null,
  packDest: null,
  contentDir: '',
  lockPath: '',
  server: null,
};

/** Run the CLI under Node, capturing output, with a hard timeout. */
function runOk(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const r = spawnSync(NODE, [H.cliPath, ...args], {
    cwd: opts.cwd ?? H.contentDir,
    timeout: opts.timeoutMs ?? 30_000,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_ENV, ...opts.env },
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 250 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Resolve true when a TCP connection to host:port succeeds. */
function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Liveness probe across both loopback families — the server may bind IPv6
 * `::1` (the usual `localhost` resolution) or IPv4 `127.0.0.1`, and forcing one
 * family flakes depending on the host's resolver order.
 */
async function tcpReachable(port: number, timeoutMs = 2000): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    tcpConnect('127.0.0.1', port, timeoutMs),
    tcpConnect('::1', port, timeoutMs),
  ]);
  return v4 || v6;
}

function readLockPort(): number | null {
  if (!existsSync(H.lockPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(H.lockPath, 'utf8')) as { port?: number };
    return typeof meta.port === 'number' ? meta.port : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  // A built dist/ is a precondition — the CI job runs `bun run build` first.
  if (!existsSync(WORKSPACE_DIST_CLI)) {
    throw new Error(
      `Missing ${WORKSPACE_DIST_CLI}. Run \`bun run build --filter=@inkeep/open-knowledge\` before this smoke.`,
    );
  }

  if (SUT_MODE === 'packed') {
    const packDest = mkdtempSync(join(tmpdir(), 'ok-e2e-pack-'));
    H.packDest = packDest;
    // `npm pack` tarballs the current dist/ per the `files` allowlist (it does
    // NOT run prepublishOnly), so the build above is what populates it.
    const packOut = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDest], {
      cwd: CLI_PKG_DIR,
      encoding: 'utf8',
    }).trim();
    const tarball = join(packDest, packOut.split('\n').pop()?.trim() ?? '');
    if (!existsSync(tarball)) throw new Error(`npm pack produced no tarball (got "${packOut}")`);

    H.installPrefix = mkdtempSync(join(tmpdir(), 'ok-e2e-install-'));
    // Install the tarball + its registry deps (incl. native prebuilds) into an
    // isolated prefix, under Node's resolution — the real user install path.
    execFileSync('npm', ['install', '--silent', '--prefix', H.installPrefix, tarball], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    const installed = join(H.installPrefix, 'node_modules', '@inkeep', 'open-knowledge');
    H.cliPath = join(installed, 'dist', 'cli.mjs');
    H.binShim = join(H.installPrefix, 'node_modules', '.bin', 'ok');
  } else {
    H.cliPath = WORKSPACE_DIST_CLI;
  }

  // Git-backed content dir — `ok init` requires a git repo (or inits one).
  H.contentDir = mkdtempSync(join(tmpdir(), 'ok-e2e-content-'));
  execFileSync('git', ['init', '-q'], { cwd: H.contentDir });
  execFileSync('git', ['config', 'user.email', 'e2e@ok.test'], { cwd: H.contentDir });
  execFileSync('git', ['config', 'user.name', 'OK E2E'], { cwd: H.contentDir });
  H.lockPath = join(H.contentDir, '.ok', 'local', 'server.lock');
}, 240_000);

afterAll(async () => {
  if (H.server && H.server.exitCode === null) {
    H.server.kill('SIGKILL');
  }
  for (const dir of [H.contentDir, H.installPrefix, H.packDest]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe(`CLI Linux e2e (${SUT_MODE} SUT)`, () => {
  test('1. install fidelity: the bin runs under Node and ships its UI + assets', () => {
    const v = runOk(['--version'], { cwd: CLI_PKG_DIR });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);

    if (SUT_MODE === 'packed') {
      const installed = dirname(dirname(H.cliPath)); // .../@inkeep/open-knowledge
      // `files` allowlist must ship the built UI bundle + skill assets.
      expect(existsSync(join(installed, 'dist', 'public'))).toBe(true);
      expect(existsSync(join(installed, 'dist', 'assets', 'skills'))).toBe(true);
      expect(H.binShim && existsSync(H.binShim)).toBe(true);
    }
  });

  test('2. ok init scaffolds .ok/ in the content dir', () => {
    const r = runOk(['init', '--no-mcp'], { timeoutMs: 60_000 });
    expect(r.status).toBe(0);
    expect(existsSync(join(H.contentDir, '.ok'))).toBe(true);
  });

  test('3. ok start boots, writes server.lock with a port, and serves HTTP', async () => {
    H.server = spawn(NODE, [H.cliPath, 'start', '--port', String(START_PORT)], {
      cwd: H.contentDir,
      env: { ...process.env, ...HERMETIC_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    H.server.stdout?.on('data', (d) => {
      serverLog += d;
    });
    H.server.stderr?.on('data', (d) => {
      serverLog += d;
    });

    const lockReady = await waitFor(() => readLockPort() !== null, { timeoutMs: 45_000 });
    // Distinguish "lock absent" from "lock present but unreadable" (a partial
    // write or corrupt JSON also makes readLockPort return null) so a timeout
    // points triage at the right cause instead of always saying "never appeared".
    const lockState = !existsSync(H.lockPath)
      ? 'lock file never appeared'
      : `lock file exists but unreadable: ${readFileSync(H.lockPath, 'utf8').slice(0, 200)}`;
    expect(lockReady, `${lockState}\nServer log:\n${serverLog}`).toBe(true);

    const port = readLockPort();
    expect(port).toBe(START_PORT);
    expect(H.server.exitCode, 'server exited during startup').toBeNull();

    // Liveness via a TCP connect to the lock port — route-agnostic proof the
    // server is bound. We don't GET `/` (the static SPA is served by the sibling
    // `ok ui`, not the bare `ok start` server); the MCP round-trip below is the
    // functional proof.
    const reachable = await waitFor(() => tcpReachable(port as number), { timeoutMs: 15_000 });
    expect(reachable, 'server port never accepted a TCP connection').toBe(true);
  }, 70_000);

  test('4. ok mcp answers a stdio round-trip: tools/list + exec + write + read-back', async () => {
    const transport = new StdioClientTransport({
      command: NODE,
      args: [H.cliPath, 'mcp'],
      cwd: H.contentDir,
      env: { ...process.env, ...HERMETIC_ENV } as Record<string, string>,
    });
    const client = new Client({ name: 'ok-e2e', version: '0.0.0' });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const required of ['exec', 'search', 'write', 'edit']) {
        expect(names.has(required), `MCP tool "${required}" missing`).toBe(true);
      }

      // write a doc, then read it back via exec(cat) — proves the CRDT write
      // spine and the read surface are both live through the packaged bin.
      const marker = `e2e-marker-${START_PORT}`;
      const writeRes = (await client.callTool({
        name: 'write',
        arguments: {
          cwd: H.contentDir,
          document: { path: 'e2e/smoke', content: `# Smoke\n\n${marker}\n` },
        },
      })) as { isError?: boolean };
      expect(writeRes.isError ?? false).toBe(false);

      const catRes = (await client.callTool({
        name: 'exec',
        arguments: { command: 'cat e2e/smoke.md', cwd: H.contentDir },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(catRes.isError ?? false).toBe(false);
      const catText = (catRes.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(catText).toContain(marker);
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);

  test('4b. bundled mermaid validator emits renderWarnings through the packed bin', async () => {
    // The advisory mermaid validator lazy-imports the BUNDLED mermaid chunk
    // graph and does its one-time happy-dom transient-globals init — under
    // Node, from the packed dist. This is the only place that proves chunk
    // resolution + the Node getter-only-globals path (navigator) survive
    // packaging; unit tests run from workspace source under Bun.
    const transport = new StdioClientTransport({
      command: NODE,
      args: [H.cliPath, 'mcp'],
      cwd: H.contentDir,
      env: { ...process.env, ...HERMETIC_ENV } as Record<string, string>,
    });
    const client = new Client({ name: 'ok-e2e-mermaid', version: '0.0.0' });
    try {
      await client.connect(transport);
      const writeRes = (await client.callTool({
        name: 'write',
        arguments: {
          cwd: H.contentDir,
          document: {
            path: 'e2e/mermaid-smoke',
            // Raw `;` in sequence message text — a statement separator in
            // mermaid's grammar, so this fence cannot render.
            content: '# Smoke\n\n```mermaid\nsequenceDiagram\n  A->>B: hi; there\n```\n',
          },
        },
      })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: {
          document?: {
            warnings?: Array<{ kind: string; fenceIndex: number; message: string }>;
          };
        };
      };
      expect(writeRes.isError ?? false).toBe(false);
      const warnings = writeRes.structuredContent?.document?.warnings;
      expect(warnings, 'warnings missing from packed-bin write response').toBeDefined();
      expect(warnings?.[0]?.kind).toBe('mermaid-parse-error');
      expect(warnings?.[0]?.message).toContain('Parse error');
      const text = (writeRes.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(text).toContain('⚠');
      expect(text).toContain('will not render');

      // The edit tool's relay path: an unrelated prose edit on the broken
      // doc still surfaces the pre-existing fence failure through `edit`.
      const editRes = (await client.callTool({
        name: 'edit',
        arguments: {
          cwd: H.contentDir,
          document: { path: 'e2e/mermaid-smoke', find: '# Smoke', replace: '# Smoke (edited)' },
        },
      })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: { document?: { warnings?: Array<{ kind: string }> } };
      };
      expect(editRes.isError ?? false).toBe(false);
      expect(editRes.structuredContent?.document?.warnings?.[0]?.kind).toBe('mermaid-parse-error');
      const editText = (editRes.content ?? []).map((c) => c.text ?? '').join('\n');
      expect(editText).toContain('will not render');

      // A valid fence through the same warmed validator stays silent.
      const validRes = (await client.callTool({
        name: 'write',
        arguments: {
          cwd: H.contentDir,
          document: {
            path: 'e2e/mermaid-smoke-valid',
            content: '```mermaid\ngraph LR\n  A-->B\n```\n',
          },
        },
      })) as {
        isError?: boolean;
        structuredContent?: { document?: { warnings?: unknown } };
      };
      expect(validRes.isError ?? false).toBe(false);
      expect(validRes.structuredContent?.document?.warnings).toBeUndefined();

      // Batch path has its own relay wiring — warnings land per-entry under
      // `documents[]`, and a failing sibling never marks the batch as error.
      const batchRes = (await client.callTool({
        name: 'write',
        arguments: {
          cwd: H.contentDir,
          documents: [
            { path: 'e2e/mermaid-batch-ok', content: '```mermaid\ngraph LR\n  A-->B\n```\n' },
            {
              path: 'e2e/mermaid-batch-bad',
              content: '```mermaid\nsequenceDiagram\n  A->>B: x; y\n```\n',
            },
          ],
        },
      })) as {
        isError?: boolean;
        structuredContent?: {
          documents?: Array<{ docName: string; warnings?: Array<{ kind: string }> }>;
        };
      };
      expect(batchRes.isError ?? false).toBe(false);
      const batchDocs = batchRes.structuredContent?.documents ?? [];
      expect(batchDocs).toHaveLength(2);
      expect(batchDocs[0]?.warnings).toBeUndefined();
      expect(batchDocs[1]?.warnings?.[0]?.kind).toBe('mermaid-parse-error');
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);

  test('5. file-watcher ingests an external disk write (inotify on Linux)', async () => {
    // Drop a markdown file straight onto disk, bypassing OK, so only the
    // server's @parcel/watcher (inotify on Linux) can bring it into the index.
    // `ok start` loads the watcher at boot, but a degraded watcher fails
    // silently — this asserts it actually delivers events disk -> CRDT/index.
    // `search` is index-backed (live-derived-index, updated by the watcher
    // path), so a hit proves ingestion, not a plain disk read like `exec cat`.
    const marker = `okwatchprobe${START_PORT}`;
    writeFileSync(
      join(H.contentDir, `${marker}.md`),
      `---\ntitle: Watcher Probe\n---\n\n# Watcher Probe\n\n${marker} body sentinel\n`,
    );

    const transport = new StdioClientTransport({
      command: NODE,
      args: [H.cliPath, 'mcp'],
      cwd: H.contentDir,
      env: { ...process.env, ...HERMETIC_ENV } as Record<string, string>,
    });
    const client = new Client({ name: 'ok-e2e-watch', version: '0.0.0' });
    try {
      await client.connect(transport);
      const found = await waitFor(
        async () => {
          const res = (await client.callTool({
            name: 'search',
            arguments: { query: marker, cwd: H.contentDir },
          })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
          if (res.isError) return false;
          const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
          return text.includes(marker);
        },
        { timeoutMs: 20_000, intervalMs: 500 },
      );
      expect(found, 'file-watcher never surfaced the disk-dropped doc via search').toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  }, 40_000);

  test('6. keyring resolves without hanging and `ok auth status` names the backend', () => {
    // Strip any session bus so the keyring path runs without a live Secret
    // Service, matching a headless server.
    const headlessEnv = { DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: '' };
    const r = runOk(['auth', 'status', '--json'], { timeoutMs: 15_000, env: headlessEnv });

    // No token is stored, so the command exits non-zero — that is expected. The
    // load-bearing assertion is that it RETURNED rather than hanging on a
    // keyring D-Bus round-trip (a real, documented Linux trap). A timeout
    // surfaces as signal !== null / status === null.
    expect(r.signal, `ok auth status hung (keyring D-Bus trap?). stderr:\n${r.stderr}`).toBeNull();

    const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
    let payload: { backend?: string };
    try {
      payload = JSON.parse(line) as { backend?: string };
    } catch {
      throw new Error(
        `Failed to parse JSON from \`ok auth status --json\`.\nLast stdout line: ${line}\nFull stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    // backend is reported in both outcomes: `keyring` when the @napi-rs/keyring
    // native prebuild loads (the case on the CI Linux runner — the prebuild
    // resolves and `new Entry()` constructs fine even with no Secret Service),
    // or `file` only when the native module fails to LOAD. Both are valid; the
    // store must resolve to one of them without crashing. The no-Secret-Service
    // condition manifests on the get/set round-trip, which the hang-guard above
    // covers — not on backend selection.
    expect(['keyring', 'file']).toContain(payload.backend);
  });

  test('7. shutdown releases the server lock', async () => {
    expect(H.server).not.toBeNull();
    const server = H.server as ChildProcess;
    const exited = new Promise<void>((res) => server.once('exit', () => res()));
    server.kill('SIGTERM');
    const cleanExit = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    expect(cleanExit, 'server did not exit within 10s of SIGTERM').toBe(true);

    const lockGone = await waitFor(() => !existsSync(H.lockPath), { timeoutMs: 5_000 });
    expect(lockGone, 'server.lock was not released on shutdown').toBe(true);
  }, 20_000);
});
