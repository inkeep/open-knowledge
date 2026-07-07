/**
 * Bundle collector library — gathers telemetry files, logs, server state, and
 * runtime metadata into a temp staging directory, then zips it for the
 * `ok diagnose bundle` command. Designed library-shaped so the CLI wrapper
 * stays thin and a future bug-report skill can call it directly.
 *
 * Two-step contract:
 *   1. `collectBundle(opts)` — stages every artifact under a tmpdir and
 *      produces a manifest. Returns a handle whose `cleanup()` releases the
 *      tmpdir.
 *   2. `writeBundle({ collected, outputPath })` — zips the stage into the
 *      target path. Caller prints the summary + prompts y/N between calls.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_LOGS_MAX_BYTES,
  DEFAULT_SPANS_MAX_BYTES,
  resolveConfigPath,
} from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { ZipFile } from 'yazl';
import { PACKAGE_VERSION } from '../constants.ts';
import { type RedactStagedBundleResult, redactStagedBundle } from './bundle-redact.ts';

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

// All types below are referenced through the public `CollectedBundle` shape
// (`collected.manifest.X` / `collected.summary.X`). They stay file-local for
// now; consumers (the deferred `/report-bug` skill) can index into the public
// types — e.g., `CollectedBundle['manifest']['files'][number]` — without
// needing to import each interface by name.

/** Schema version pinned at 1 for v1 bundles. */
type BundleSchemaVersion = 1;

interface DesktopMetadata {
  electronVersion: string;
  packaged: boolean;
  channel: string;
}

interface BundleFileEntry {
  /** Path relative to the zip root, e.g. `"telemetry/spans-current.jsonl"`. */
  path: string;
  /** Uncompressed byte size. */
  bytes: number;
  /**
   * Newline count for line-delimited files (JSONL). Files where line counting
   * doesn't apply (json, txt, lock blobs, the eventual `process/` payload)
   * record `0`. Consumers should not infer "empty" from `lines: 0` — `bytes`
   * is the size of record.
   */
  lines: number;
}

interface BundleRedaction {
  applied: boolean;
  /**
   * Filename of the inverse-map sidecar written next to the zip on the user's
   * own machine — NOT included in the zip. The recipient sees only the
   * filename for reference; the actual `<hashed> → <original>` map stays
   * with the user so they can de-anonymize a bundle they sent without giving
   * the recipient the ability to reverse it.
   */
  docNameMapSidecar: string | null;
  /**
   * Hashes for which two or more distinct originals were observed during
   * redaction. Each value is the list of additional originals beyond the
   * one stored in the sidecar map. Field is absent when no collision
   * occurred; present and non-empty means the sidecar map is lossy for
   * those hashes.
   */
  docNameCollisions?: Record<string, string[]>;
}

type BundleServerStatus = 'running' | 'not-running';

interface BundleManifest {
  schemaVersion: BundleSchemaVersion;
  createdAt: string;
  ok: {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  host: {
    desktop: DesktopMetadata | null;
  };
  contentDir: {
    /** SHA-256 of the absolute content-dir path. 64 lowercase hex chars. */
    pathSha256: string;
    absolutePath: string;
  };
  telemetry: {
    localSink: {
      enabled: boolean;
      spansMaxBytes: number;
      logsMaxBytes: number;
    };
    otlpPushEnabled: boolean;
  };
  redaction: BundleRedaction;
  serverStatus: BundleServerStatus;
  files: BundleFileEntry[];
}

// ---------------------------------------------------------------------------
// Collector input / output
// ---------------------------------------------------------------------------

export interface CollectBundleOpts {
  /**
   * Resolved content directory (`resolve(cwd, content.dir)`). Used for the
   * content-path redaction scan + the manifest's `contentDir` block — NOT for
   * locating `.ok/local/` runtime artifacts, which are anchored on
   * `projectDir` (see below). Resolved to abs.
   */
  contentDir: string;
  /**
   * Project root (where `.ok/` lives). Defaults to `contentDir`. When
   * `content.dir` is not the project root (e.g. `content.dir: docs`), this is
   * where ALL per-machine runtime state lives — the `telemetry.localSink`
   * manifest config block AND the on-disk `.ok/local/` artifacts the bundle
   * harvests (spans, logs, `server.lock`). Anchoring those reads on
   * `contentDir` would miss them: the server writes them under
   * `<projectDir>/.ok/local/`, never inside the content sub-folder.
   */
  projectDir?: string;
  /** Optional path to an existing `ok diagnose process` output dir; copied to `process/` in the bundle. */
  processDir?: string;
  /**
   * Apply `--redact` to the staged copies: hash `doc.name` attribute values
   * with BLAKE2b-256(value).slice(0,8), replace the absolute content-dir
   * prefix in any string field with the literal `<CONTENT_DIR>` token, and
   * record the inverse map in `manifest.redaction.docNameMap`. The original
   * on-disk files under `<contentDir>/.ok/local/{telemetry,logs}/` are
   * untouched — the collector copies them first; the redactor only sees the
   * staged copies.
   */
  redact?: boolean;
  /** Test-injectable dependencies — every field defaults to a real-system implementation. */
  deps?: CollectBundleDeps;
}

export interface CollectBundleDeps {
  /**
   * Fetch the running server's `GET /api/metrics/agent-presence` response,
   * within the 1s budget. Returns the response body string on 2xx, or `null`
   * on any failure (network, timeout, non-2xx).
   */
  fetchAgentPresence?: (port: number) => Promise<string | null>;
  /**
   * Read the last 50 entries of the shadow repo log at
   * `<contentDir>/.git/ok/`. Returns the stdout string or `null` if the
   * shadow repo is missing or git fails.
   */
  readShadowHead?: (contentDir: string) => string | null;
  /** Returns the current timestamp. Override in tests for determinism. */
  now?: () => Date;
  /** Returns the OK CLI's package version. */
  okVersion?: () => string;
  /** Returns the `OK_DESKTOP_*` env block, or `null` when no desktop host is present. */
  readDesktopEnv?: () => DesktopMetadata | null;
  /** Returns runtime introspection — Node version, platform, arch. */
  readRuntime?: () => { nodeVersion: string; platform: string; arch: string };
  /**
   * Whether the OTLP push exporter is enabled. Tracks `OTEL_SDK_DISABLED ===
   * 'false'` in production — exposed for tests so the gate is observable.
   */
  isOtlpPushEnabled?: () => boolean;
}

interface BundleSummary {
  /** Sum of `bytes` across `files[]` — pre-zip uncompressed size. */
  totalBytes: number;
  /** Length of `files[]`. */
  fileCount: number;
  /**
   * Approximate number of `doc.name` attribute occurrences visible in spans
   * — for the pre-zip y/N prompt. Counted by line-scanning the JSONLs for
   * `"doc.name"` substring; a non-zero count tells the user how exposed the
   * bundle is without forcing a full JSON parse. Substring collisions are
   * vanishingly rare for the prompt's purpose.
   */
  docNameCount: number;
  /** True when the absolute content-dir path appears in any non-manifest staged file. */
  contentDirVisible: boolean;
  /** Whether `--redact` was applied. Matches `manifest.redaction.applied`. */
  redacted: boolean;
}

export interface CollectedBundle {
  /** Temp staging directory containing every artifact + `manifest.json` at the root. */
  stagingDir: string;
  manifest: BundleManifest;
  summary: BundleSummary;
  /**
   * In-memory inverse map produced when `--redact` was applied. Held here so
   * `writeBundle` can persist it to a sidecar file next to the zip — NEVER
   * inside the zip. `null` when redaction was not applied.
   */
  redactionMapPayload: {
    docNameMap: Record<string, string>;
    docNameCollisions: Record<string, string[]>;
  } | null;
  /** Removes the staging dir. Idempotent. */
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Writer input
// ---------------------------------------------------------------------------

export interface WriteBundleOpts {
  collected: CollectedBundle;
  /** Absolute path where the zip is written. Parent dir must already exist. */
  outputPath: string;
}

// ---------------------------------------------------------------------------
// Path helpers (mirror server's `telemetry-file-sink.ts`)
// ---------------------------------------------------------------------------

// Inlined rather than imported from the server because the layout is a
// contract — three dirs under `.ok/local/`, fixed filenames. The
// CLI is the consumer of the spans/logs writer; coupling to the writer's
// types would invert the dependency direction.

const TELEMETRY_REL = ['.ok', 'local', 'telemetry'] as const;
const LOGS_REL = ['.ok', 'local', 'logs'] as const;
const SPANS_CURRENT = 'spans-current.jsonl';
const SPANS_PREVIOUS = 'spans-prev.jsonl';
const LOGS_CURRENT = 'server-current.jsonl';
const LOGS_PREVIOUS = 'server-prev.jsonl';

function spansCurrentPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_REL, SPANS_CURRENT);
}

function spansPreviousPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_REL, SPANS_PREVIOUS);
}

function logsCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOGS_REL, LOGS_CURRENT);
}

function logsPreviousPath(projectDir: string): string {
  return join(projectDir, ...LOGS_REL, LOGS_PREVIOUS);
}

// Exposed so a cross-package parity test can assert these inlined paths stay
// equivalent to the server's `telemetry-file-sink.ts` exports — the layout is
// a contract, but no compiler check catches drift between
// the two sites today (the duplication is intentional per dependency-direction
// concerns).
export const _pathHelpersForTests = {
  spansCurrentPath,
  spansPreviousPath,
  logsCurrentPath,
  logsPreviousPath,
};

// ---------------------------------------------------------------------------
// Defaults — production implementations of the test-injectable deps
// ---------------------------------------------------------------------------

const AGENT_PRESENCE_TIMEOUT_MS = 1000;
const SHADOW_GIT_LOG_LIMIT = 50;

async function defaultFetchAgentPresence(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/metrics/agent-presence`, {
      signal: AbortSignal.timeout(AGENT_PRESENCE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    // Timeout, ECONNREFUSED, DNS, JSON-parse drift — all collapse to null so
    // a not-running server doesn't fail the bundle (bug reports are often
    // "the server crashed"). Caller writes `server-status.txt: not-running`.
    return null;
  }
}

function defaultReadShadowHead(contentDir: string): string | null {
  const shadowDir = join(contentDir, '.git', 'ok');
  if (!existsSync(shadowDir)) return null;
  const result = spawnSync(
    'git',
    ['-C', shadowDir, 'log', '--oneline', `-${SHADOW_GIT_LOG_LIMIT}`],
    { encoding: 'utf-8', timeout: 2000 },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

function defaultReadDesktopEnv(): DesktopMetadata | null {
  const electronVersion = process.env.OK_DESKTOP_VERSION;
  const packagedRaw = process.env.OK_DESKTOP_PACKAGED;
  const channel = process.env.OK_DESKTOP_CHANNEL;
  // All three present → emit a complete block. Partial → null (don't pretend
  // we know what we don't); the recipient sees `desktop: null` and infers
  // "this bundle wasn't from the Electron host."
  if (electronVersion === undefined || packagedRaw === undefined || channel === undefined) {
    return null;
  }
  return {
    electronVersion,
    packaged: packagedRaw === '1' || packagedRaw.toLowerCase() === 'true',
    channel,
  };
}

function defaultReadRuntime(): { nodeVersion: string; platform: string; arch: string } {
  return {
    nodeVersion: process.version,
    platform: osPlatform(),
    arch: osArch(),
  };
}

function defaultIsOtlpPushEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED === 'false';
}

// ---------------------------------------------------------------------------
// Config-derived telemetry block
// ---------------------------------------------------------------------------

interface LocalSinkBlock {
  enabled: boolean;
  spansMaxBytes: number;
  logsMaxBytes: number;
}

interface RawLocalSinkBlock {
  enabled?: unknown;
  spans?: { maxBytes?: unknown } | null;
  logs?: { maxBytes?: unknown } | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse the raw YAML at `absPath` and extract `telemetry.localSink`. Mirrors
 * the server's `readRawSinkBlock` helper — we deliberately avoid
 * `readConfigSafely` here because it applies schema defaults, which would
 * make project-local always shadow project even when the user left the local
 * file empty. The manifest must report the same effective state as the
 * server's actual gate (resolved via `local-sink-resolver.ts`).
 */
function readRawSinkBlock(absPath: string): RawLocalSinkBlock {
  if (!existsSync(absPath)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    // Surface the parse failure so the bundle recipient can see why the
    // manifest's telemetry block reports schema defaults — the alternative
    // is a silent disagreement between manifest config and runtime config.
    console.warn(
      `[ok diagnose bundle] failed to parse ${absPath} for manifest config; ` +
        `manifest will report schema defaults. Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (!isObject(parsed)) return {};
  const telemetry = parsed.telemetry;
  if (!isObject(telemetry)) return {};
  const localSink = telemetry.localSink;
  if (!isObject(localSink)) return {};
  return localSink as RawLocalSinkBlock;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readMaxBytes(block: { maxBytes?: unknown } | null | undefined): number | undefined {
  if (!isObject(block)) return undefined;
  return readPositiveNumber(block.maxBytes);
}

/**
 * Resolve the `telemetry.localSink` block for the manifest. Always returns a
 * fully-populated block (even when disabled) — the manifest records the
 * effective config so a recipient can correlate file presence with intent.
 * Per-leaf cascade: project-local explicit > project explicit > schema
 * default. Implementation matches `local-sink-resolver.ts` on the server side
 * so the manifest and the actual gate cannot disagree.
 */
function resolveLocalSinkBlock(projectDir: string): LocalSinkBlock {
  const projectSink = readRawSinkBlock(resolveConfigPath('project', projectDir));
  const localSink = readRawSinkBlock(resolveConfigPath('project-local', projectDir));
  const enabled = readBoolean(localSink.enabled) ?? readBoolean(projectSink.enabled) ?? true;
  const spansMaxBytes =
    readMaxBytes(localSink.spans) ?? readMaxBytes(projectSink.spans) ?? DEFAULT_SPANS_MAX_BYTES;
  const logsMaxBytes =
    readMaxBytes(localSink.logs) ?? readMaxBytes(projectSink.logs) ?? DEFAULT_LOGS_MAX_BYTES;
  return { enabled, spansMaxBytes, logsMaxBytes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashContentDirPath(absolutePath: string): string {
  return createHash('sha256').update(absolutePath).digest('hex');
}

function countLines(filePath: string): number {
  // Count newline bytes — JSONL convention is one record per line, terminated
  // with `\n`. A partial last line (e.g., after SIGKILL) is not counted —
  // readers skip lines that fail to parse, so counting only terminated lines
  // is the truthful answer.
  const buf = readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  return count;
}

function countDocNameOccurrences(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  const marker = '"doc.name"';
  let count = 0;
  let idx = content.indexOf(marker);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(marker, idx + marker.length);
  }
  return count;
}

function stageFileIfPresent(srcPath: string, destPath: string): boolean {
  if (!existsSync(srcPath)) return false;
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(srcPath, destPath);
  return true;
}

function walkStagedFiles(stagingDir: string): string[] {
  const results: string[] = [];
  const recurse = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  recurse(stagingDir);
  return results.sort();
}

const LINE_COUNTED_EXTENSIONS = new Set(['.jsonl']);

function shouldCountLines(relPath: string): boolean {
  const lastDot = relPath.lastIndexOf('.');
  if (lastDot === -1) return false;
  return LINE_COUNTED_EXTENSIONS.has(relPath.slice(lastDot));
}

function relativeZipPath(stagingDir: string, absPath: string): string {
  return relative(stagingDir, absPath).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// collectBundle
// ---------------------------------------------------------------------------

export async function collectBundle(opts: CollectBundleOpts): Promise<CollectedBundle> {
  const contentDir = resolve(opts.contentDir);
  // Per-machine runtime state (`.ok/local/`) is anchored on the project root,
  // not `content.dir` — `server.lock`, the telemetry span sink, and the log
  // sink all live under `<projectDir>/.ok/local/` regardless of where
  // `content.dir` points. Defaults to `contentDir` when the caller omits
  // `projectDir` (the two coincide for `content.dir: '.'`).
  const projectDir = resolve(opts.projectDir ?? opts.contentDir);
  const deps = opts.deps ?? {};
  const fetchAgentPresence = deps.fetchAgentPresence ?? defaultFetchAgentPresence;
  const readShadowHead = deps.readShadowHead ?? defaultReadShadowHead;
  const now = deps.now ?? (() => new Date());
  const okVersion = deps.okVersion ?? (() => PACKAGE_VERSION);
  const readDesktopEnv = deps.readDesktopEnv ?? defaultReadDesktopEnv;
  const readRuntime = deps.readRuntime ?? defaultReadRuntime;
  const isOtlpPushEnabled = deps.isOtlpPushEnabled ?? defaultIsOtlpPushEnabled;

  const stagingDir = mkdtempSync(join(tmpdir(), 'ok-bundle-'));
  mkdirSync(join(stagingDir, 'telemetry'), { recursive: true });
  mkdirSync(join(stagingDir, 'logs'), { recursive: true });
  mkdirSync(join(stagingDir, 'state'), { recursive: true });

  stageFileIfPresent(spansCurrentPath(projectDir), join(stagingDir, 'telemetry', SPANS_CURRENT));
  stageFileIfPresent(spansPreviousPath(projectDir), join(stagingDir, 'telemetry', SPANS_PREVIOUS));
  stageFileIfPresent(logsCurrentPath(projectDir), join(stagingDir, 'logs', LOGS_CURRENT));
  stageFileIfPresent(logsPreviousPath(projectDir), join(stagingDir, 'logs', LOGS_PREVIOUS));

  // Server lock + status + agent presence.
  const lockDir = join(projectDir, '.ok', 'local');
  const lockPath = join(lockDir, 'server.lock');
  let serverStatus: BundleServerStatus = 'not-running';
  let serverStatusReason = 'no server.lock';
  let lockPort: number | null = null;

  if (existsSync(lockPath)) {
    stageFileIfPresent(lockPath, join(stagingDir, 'state', 'server.lock'));
    try {
      const lockContent = readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(lockContent) as { port?: number };
      if (typeof lock.port === 'number') {
        lockPort = lock.port;
      } else {
        serverStatusReason = 'lock present but no port';
      }
    } catch {
      serverStatusReason = 'lock present but unparseable';
    }
  }

  if (lockPort !== null) {
    const presence = await fetchAgentPresence(lockPort);
    if (presence !== null) {
      writeFileSync(join(stagingDir, 'state', 'agent-presence.json'), presence);
      serverStatus = 'running';
      serverStatusReason = '';
    } else {
      serverStatusReason = `agent-presence endpoint at :${lockPort} unreachable`;
    }
  }

  // Shadow-repo head — best effort.
  const shadowHead = readShadowHead(contentDir);
  if (shadowHead !== null) {
    writeFileSync(join(stagingDir, 'state', 'shadow-head.txt'), shadowHead);
  }

  // last-spawn-error.log (Electron host writes this when a spawn fails).
  stageFileIfPresent(
    join(lockDir, 'last-spawn-error.log'),
    join(stagingDir, 'state', 'last-spawn-error.log'),
  );

  // Runtime + desktop block.
  const runtime = readRuntime();
  const desktop = readDesktopEnv();
  const runtimeJson = {
    ok: {
      version: okVersion(),
      nodeVersion: runtime.nodeVersion,
      platform: runtime.platform,
      arch: runtime.arch,
    },
    host: { desktop },
  };
  writeFileSync(
    join(stagingDir, 'state', 'runtime.json'),
    `${JSON.stringify(runtimeJson, null, 2)}\n`,
  );

  const statusBody =
    serverStatus === 'running' ? 'running\n' : `not-running (${serverStatusReason})\n`;
  writeFileSync(join(stagingDir, 'state', 'server-status.txt'), statusBody);

  // process/ — only when caller hands us a pre-collected dir.
  if (opts.processDir && existsSync(opts.processDir)) {
    const processDest = join(stagingDir, 'process');
    mkdirSync(processDest, { recursive: true });
    cpSync(opts.processDir, processDest, { recursive: true });
  }

  // Apply redaction to the staged copies BEFORE the file inventory walk so
  // the recorded bytes/lines reflect post-redaction state. Originals on disk
  // are not touched — only the staged copies in stagingDir. The redactor
  // returns the inverse map for the manifest.
  let redactionResult: RedactStagedBundleResult | null = null;
  if (opts.redact === true) {
    redactionResult = redactStagedBundle({ stagingDir, contentDir });
  }

  // Manifest. Config lookup uses projectDir (where `.ok/config.yml` lives)
  // rather than contentDir — when `content.dir != '.'`, these differ and
  // contentDir wouldn't contain the project config file.
  const localSink = resolveLocalSinkBlock(projectDir);
  const stagedFiles = walkStagedFiles(stagingDir);
  const files: BundleFileEntry[] = [];
  let totalBytes = 0;
  let docNameCount = 0;
  for (const absPath of stagedFiles) {
    const relPath = relativeZipPath(stagingDir, absPath);
    const bytes = statSync(absPath).size;
    const lines = shouldCountLines(relPath) ? countLines(absPath) : 0;
    files.push({ path: relPath, bytes, lines });
    totalBytes += bytes;
    if (relPath.startsWith('telemetry/') && shouldCountLines(relPath)) {
      docNameCount += countDocNameOccurrences(absPath);
    }
  }

  const manifest: BundleManifest = {
    schemaVersion: 1,
    createdAt: now().toISOString(),
    ok: {
      version: okVersion(),
      nodeVersion: runtime.nodeVersion,
      platform: runtime.platform,
      arch: runtime.arch,
    },
    host: { desktop },
    contentDir: {
      // pathSha256 stays as the SHA-256 of the original absolute path — it's
      // a stable correlation identifier for the recipient. The absolutePath
      // string itself is masked when redaction is on so the bundle doesn't
      // leak the user's home directory layout.
      pathSha256: hashContentDirPath(contentDir),
      absolutePath: redactionResult !== null ? '<CONTENT_DIR>' : contentDir,
    },
    telemetry: {
      localSink,
      otlpPushEnabled: isOtlpPushEnabled(),
    },
    redaction:
      redactionResult !== null
        ? Object.keys(redactionResult.docNameCollisions).length > 0
          ? {
              applied: true,
              docNameMapSidecar: null,
              docNameCollisions: redactionResult.docNameCollisions,
            }
          : { applied: true, docNameMapSidecar: null }
        : { applied: false, docNameMapSidecar: null },
    serverStatus,
    files,
  };

  writeFileSync(join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // contentDirVisible scan runs AFTER manifest write so it doesn't include
  // the manifest's own `absolutePath` field — the user's prompt cares about
  // JSONLs + state files where the path bleeds in via spans / logs / lock
  // metadata, not the recipient-facing inventory.
  const contentDirVisible = stagedFiles.some((absPath) => {
    try {
      return readFileSync(absPath, 'utf-8').includes(contentDir);
    } catch {
      // Binary file (cpuprofile, dmp) — skip the substring scan.
      return false;
    }
  });

  const summary: BundleSummary = {
    totalBytes,
    fileCount: files.length,
    docNameCount,
    contentDirVisible,
    redacted: redactionResult !== null,
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(stagingDir, { recursive: true, force: true });
  };

  const redactionMapPayload =
    redactionResult !== null
      ? {
          docNameMap: redactionResult.docNameMap,
          docNameCollisions: redactionResult.docNameCollisions,
        }
      : null;

  return { stagingDir, manifest, summary, redactionMapPayload, cleanup };
}

// ---------------------------------------------------------------------------
// writeBundle
// ---------------------------------------------------------------------------

export async function writeBundle(opts: WriteBundleOpts): Promise<string> {
  const { collected, outputPath } = opts;
  const parent = dirname(outputPath);
  if (!existsSync(parent)) {
    throw new Error(
      `ok diagnose bundle: parent directory does not exist: ${parent}. ` +
        'Create it or pass --out with an existing parent.',
    );
  }

  // When redaction was applied, restamp the staged manifest with the sidecar
  // filename so the recipient sees a pointer (not the map itself). The sidecar
  // is written next to the zip below — outside the zip, on the user's machine
  // only. This preserves the contract: "downstream consumers see only
  // hashes."
  if (collected.redactionMapPayload !== null) {
    const sidecarName = `${basename(outputPath, '.zip')}.docnames.json`;
    const stampedManifest: BundleManifest = {
      ...collected.manifest,
      redaction: {
        ...collected.manifest.redaction,
        applied: true,
        docNameMapSidecar: sidecarName,
      },
    };
    writeFileSync(
      join(collected.stagingDir, 'manifest.json'),
      `${JSON.stringify(stampedManifest, null, 2)}\n`,
    );
  }

  const zipfile = new ZipFile();
  const absStagedFiles = walkStagedFiles(collected.stagingDir);
  for (const absPath of absStagedFiles) {
    const relPath = relativeZipPath(collected.stagingDir, absPath);
    zipfile.addFile(absPath, relPath);
  }
  zipfile.end();

  // Write the inverse-map sidecar next to the zip (NOT inside it). The user
  // keeps this locally so they can de-anonymize their own bundle if they ever
  // need to; the recipient only ever gets the zip. Mode 0o600 because the
  // sidecar contains the exact data --redact was meant to keep private —
  // default umask would leave it world-readable on shared systems.
  if (collected.redactionMapPayload !== null) {
    const sidecarName = `${basename(outputPath, '.zip')}.docnames.json`;
    const sidecarPath = join(parent, sidecarName);
    writeFileSync(
      sidecarPath,
      `${JSON.stringify(
        {
          docNameMap: collected.redactionMapPayload.docNameMap,
          docNameCollisions: collected.redactionMapPayload.docNameCollisions,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  const writer = createWriteStream(outputPath);
  zipfile.outputStream.pipe(writer);
  await new Promise<void>((resolveWait, rejectWait) => {
    writer.on('close', resolveWait);
    writer.on('error', rejectWait);
    zipfile.outputStream.on('error', rejectWait);
  });

  return outputPath;
}
