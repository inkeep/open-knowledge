/**
 * Managed language runtimes for ACP agents — the "works even without system
 * npx/uvx" path.
 *
 * Most registry agents distribute through `npx <pkg>` (npm) or `uvx <pkg>`
 * (uv). Those interpreters are absent on plenty of machines: OK Desktop
 * bundles Electron's Node runtime but NOT npm, and a fresh macOS/Windows box
 * rarely has uv. Rather than fail the launch (see `preflightLaunch` in
 * `launch.ts`), OK can download an official, pinned copy of the runtime the
 * agent needs into a private per-user cache and launch through that — the
 * same approach Zed's `node_runtime` crate takes.
 *
 * Two hard rules distinguish this from Zed's implementation:
 *
 *   1. **Consent.** Nothing downloads without the user's explicit go-ahead
 *      (persisted per-runtime under `~/.ok/`). The gate + prompt live in the
 *      thread manager; this module only reads/writes the decision and does the
 *      download once told to.
 *   2. **Verification.** Every archive is checked against the publisher's
 *      SHA-256 (Node's `SHASUMS256.txt`, uv's per-asset `.sha256`) before it
 *      is trusted — an unverified download is discarded.
 *
 * Nothing here ships in OK artifacts: the runtimes are fetched at launch time
 * into `~/.ok/runtimes/`, so OK's own distribution stays free of Node/uv
 * redistribution. Extraction + the escape guard are shared with the binary
 * agent path via `archive.ts`.
 */

import { access, constants, readdir, stat } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { tracedMkdir, tracedRename, tracedRm, tracedWriteFile } from '../fs-traced.ts';
import type { PinoLogger } from '../logger.ts';
import {
  type DownloadProgress,
  downloadToFileWithSha,
  extractArchive,
  fetchText,
  isWithin,
  sanitizeSegment,
  shaForFile,
} from './archive.ts';

export type ManagedRuntimeKind = 'node' | 'uv';

/**
 * Pinned runtime versions. Bumping is a one-line change here; both hosts keep
 * every historical version, and the SHA-256 is fetched + verified at download
 * time, so no in-repo checksum table needs maintaining.
 */
const PINNED_NODE_VERSION = 'v24.18.0'; // current LTS line ("Krypton")
const PINNED_UV_VERSION = '0.11.28';

const NODE_DIST_BASE = 'https://nodejs.org/dist';
const UV_RELEASE_BASE = 'https://github.com/astral-sh/uv/releases/download';

/** Approximate compressed download sizes (MB), for the consent prompt only. */
const APPROX_SIZE_MB: Record<ManagedRuntimeKind, number> = { node: 45, uv: 20 };

interface ManagedNode {
  kind: 'node';
  /** Prepended to PATH so `npx`/`npm` resolve their sibling `node`. */
  binDir: string;
  /** The `npx` launcher (`npx.cmd` on Windows). */
  npxBin: string;
  /** Private npm cache so package installs never touch the user's `~/.npm`. */
  cacheDir: string;
}

interface ManagedUv {
  kind: 'uv';
  binDir: string;
  /** The `uvx` launcher (`uvx.exe` on Windows). */
  uvxBin: string;
  /** Private uv cache dir. */
  cacheDir: string;
}

export type ManagedRuntime = ManagedNode | ManagedUv;

/** Consent-prompt payload: what the user is agreeing to download. */
export interface RuntimeDescriptor {
  kind: ManagedRuntimeKind;
  /** Human name — "Node.js" / "uv". */
  displayName: string;
  /** The interpreter this unlocks — "npx" / "uvx". */
  provides: string;
  version: string;
  approxSizeMB: number;
  /** Download host, surfaced so the user sees where bytes come from. */
  sourceHost: string;
}

export function runtimeForInterpreter(kind: 'npx' | 'uvx'): ManagedRuntimeKind {
  return kind === 'npx' ? 'node' : 'uv';
}

export function describeRuntime(kind: ManagedRuntimeKind): RuntimeDescriptor {
  return kind === 'node'
    ? {
        kind: 'node',
        displayName: 'Node.js',
        provides: 'npx',
        version: PINNED_NODE_VERSION,
        approxSizeMB: APPROX_SIZE_MB.node,
        sourceHost: 'nodejs.org',
      }
    : {
        kind: 'uv',
        displayName: 'uv',
        provides: 'uvx',
        version: PINNED_UV_VERSION,
        approxSizeMB: APPROX_SIZE_MB.uv,
        sourceHost: 'github.com/astral-sh',
      };
}

/** `~/.ok` — the user-level OK home shared across projects. */
function okHomeDir(): string {
  return join(homedir(), OK_DIR);
}

/** Root under which each runtime's per-version tree + private caches live. */
function defaultRuntimeRoot(): string {
  return join(okHomeDir(), 'runtimes');
}

function versionOf(kind: ManagedRuntimeKind): string {
  return kind === 'node' ? PINNED_NODE_VERSION : PINNED_UV_VERSION;
}

function launcherNames(kind: ManagedRuntimeKind): string[] {
  const win = process.platform === 'win32';
  if (kind === 'node') return win ? ['npx.cmd', 'npx.exe'] : ['npx'];
  return win ? ['uvx.exe'] : ['uvx'];
}

interface ArtifactSpec {
  archiveUrl: string;
  checksumUrl: string;
  archiveName: string;
  isZip: boolean;
}

/** Node dist naming: `node-<version>-<os>-<arch>.<ext>`. */
function nodeArtifact(): ArtifactSpec | null {
  const os = platform();
  const cpu = arch();
  const osKey =
    os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os === 'win32' ? 'win' : null;
  const cpuKey = cpu === 'arm64' ? 'arm64' : cpu === 'x64' ? 'x64' : null;
  if (osKey === null || cpuKey === null) return null;
  const isZip = os === 'win32';
  const ext = isZip ? 'zip' : 'tar.gz';
  const archiveName = `node-${PINNED_NODE_VERSION}-${osKey}-${cpuKey}.${ext}`;
  return {
    archiveUrl: `${NODE_DIST_BASE}/${PINNED_NODE_VERSION}/${archiveName}`,
    checksumUrl: `${NODE_DIST_BASE}/${PINNED_NODE_VERSION}/SHASUMS256.txt`,
    archiveName,
    isZip,
  };
}

/** uv release naming: `uv-<target-triple>.<ext>` with a sibling `.sha256`. */
function uvArtifact(): ArtifactSpec | null {
  const key = `${platform()}-${arch()}`;
  const triple: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const target = triple[key];
  if (target === undefined) return null;
  const isZip = platform() === 'win32';
  const ext = isZip ? 'zip' : 'tar.gz';
  const archiveName = `uv-${target}.${ext}`;
  return {
    archiveUrl: `${UV_RELEASE_BASE}/${PINNED_UV_VERSION}/${archiveName}`,
    checksumUrl: `${UV_RELEASE_BASE}/${PINNED_UV_VERSION}/${archiveName}.sha256`,
    archiveName,
    isZip,
  };
}

function artifactFor(kind: ManagedRuntimeKind): ArtifactSpec | null {
  return kind === 'node' ? nodeArtifact() : uvArtifact();
}

/** True when this host has a download target for `kind` (else the user must install it manually). */
export function runtimeDownloadSupported(kind: ManagedRuntimeKind): boolean {
  return artifactFor(kind) !== null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Depth-bounded search for a launcher (`npx`/`uvx`) inside an extracted tree.
 * Node ships it two levels down (`node-v…/bin/npx`, a symlink), uv one level
 * (`uv-<triple>/uvx`) or at the root (Windows zip) — one search covers all.
 */
async function findLauncher(
  dir: string,
  names: string[],
  maxDepth: number,
): Promise<string | null> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if ((e.isFile() || e.isSymbolicLink()) && names.includes(e.name)) {
      return join(dir, e.name);
    }
  }
  if (maxDepth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findLauncher(join(dir, e.name), names, maxDepth - 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function toRuntime(kind: ManagedRuntimeKind, launcher: string, root: string): ManagedRuntime {
  const binDir = dirname(launcher);
  const cacheDir = join(root, 'cache', kind);
  return kind === 'node'
    ? { kind: 'node', binDir, npxBin: launcher, cacheDir }
    : { kind: 'uv', binDir, uvxBin: launcher, cacheDir };
}

/**
 * Locate an already-installed managed runtime for the pinned version, or null.
 * Cheap: a directory stat plus a bounded launcher search — the fast path every
 * launch takes once a runtime is installed.
 */
export async function findManagedRuntime(
  kind: ManagedRuntimeKind,
  root: string = defaultRuntimeRoot(),
): Promise<ManagedRuntime | null> {
  const versionDir = join(root, kind, sanitizeSegment(versionOf(kind)));
  try {
    if (!(await stat(versionDir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const launcher = await findLauncher(versionDir, launcherNames(kind), 3);
  if (launcher === null || !(await isExecutable(launcher))) return null;
  return toRuntime(kind, launcher, root);
}

export interface EnsureRuntimeOptions {
  root?: string;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeInstallError';
  }
}

/**
 * Download + verify + install a managed runtime once per pinned version;
 * later launches reuse the extracted tree. Verified against the publisher's
 * SHA-256 before it is trusted. Extraction lands in a temp dir and is renamed
 * into place so a crash mid-install never leaves a half-tree that the
 * fast-path check would accept.
 *
 * The CALLER is responsible for consent — this only runs once told to.
 */
export async function ensureManagedRuntime(
  kind: ManagedRuntimeKind,
  log: PinoLogger,
  opts: EnsureRuntimeOptions = {},
): Promise<ManagedRuntime> {
  const root = opts.root ?? defaultRuntimeRoot();
  const existing = await findManagedRuntime(kind, root);
  if (existing !== null) return existing;

  const spec = artifactFor(kind);
  if (spec === null) {
    throw new RuntimeInstallError(`no ${kind} build for ${platform()}-${arch()}`);
  }

  const versionDir = join(root, kind, sanitizeSegment(versionOf(kind)));
  const stagingDir = join(tmpdir(), `ok-runtime-${kind}-${process.pid}-${Date.now()}`);
  await tracedMkdir(stagingDir, { recursive: true });
  const archivePath = join(stagingDir, spec.archiveName);
  log.info(
    { kind, version: versionOf(kind), url: spec.archiveUrl },
    '[managed-runtime] downloading runtime',
  );
  try {
    const [actualSha, checksums] = await Promise.all([
      downloadToFileWithSha(spec.archiveUrl, archivePath, {
        signal: opts.signal,
        onProgress: opts.onProgress,
        fetchImpl: opts.fetchImpl,
      }),
      fetchText(spec.checksumUrl, { signal: opts.signal, fetchImpl: opts.fetchImpl }),
    ]);
    const expectedSha = shaForFile(checksums, spec.archiveName);
    if (expectedSha === null) {
      throw new RuntimeInstallError(`no published checksum for ${spec.archiveName}`);
    }
    if (actualSha !== expectedSha) {
      throw new RuntimeInstallError(
        `checksum mismatch for ${spec.archiveName}: got ${actualSha}, expected ${expectedSha}`,
      );
    }

    const extractDir = join(stagingDir, 'extracted');
    await tracedMkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir, spec.isZip);
    const launcher = await findLauncher(extractDir, launcherNames(kind), 3);
    if (launcher === null || !isWithin(extractDir, launcher)) {
      throw new RuntimeInstallError(`extracted ${kind} archive has no usable launcher`);
    }

    // A concurrent launch (two npm agents started on a bare machine) may have
    // finished installing the same version while we downloaded — adopt it and
    // drop our copy rather than racing on the rename.
    const raced = await findManagedRuntime(kind, root);
    if (raced !== null) return raced;

    await tracedMkdir(join(root, kind), { recursive: true });
    await tracedRm(versionDir, { recursive: true, force: true });
    await tracedRename(extractDir, versionDir);
    log.info({ kind, version: versionOf(kind), versionDir }, '[managed-runtime] runtime installed');
    const installed = await findManagedRuntime(kind, root);
    if (installed === null) {
      throw new RuntimeInstallError(`installed ${kind} runtime not found after extract`);
    }
    return installed;
  } catch (err) {
    if (err instanceof RuntimeInstallError) throw err;
    throw new RuntimeInstallError(
      `installing ${kind} ${versionOf(kind)} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await tracedRm(stagingDir, { recursive: true, force: true }).catch(() => {
      // Best-effort temp cleanup.
    });
  }
}

// --- Consent persistence ----------------------------------------------------
//
// A machine-/user-level decision (the download is user-level, shared across
// projects), stored beside the runtime cache rather than in a project's
// committed config — a teammate's clone must not pre-grant a download on this
// machine (same locality reasoning as `server.lock` / `acp-agents.json`).

export type RuntimeConsentDecision = 'granted' | 'declined';

export interface RuntimeConsentState {
  node?: RuntimeConsentDecision;
  uv?: RuntimeConsentDecision;
}

const CONSENT_FILE = 'acp-runtime-consent.json';

/** Read the persisted per-runtime consent decisions (empty on any read/parse error). */
export async function readRuntimeConsent(home: string = okHomeDir()): Promise<RuntimeConsentState> {
  let text: string;
  try {
    const { readFile } = await import('node:fs/promises');
    text = await readFile(join(home, CONSENT_FILE), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pick = (v: unknown): RuntimeConsentDecision | undefined =>
      v === 'granted' || v === 'declined' ? v : undefined;
    return { node: pick(parsed.node), uv: pick(parsed.uv) };
  } catch {
    return {};
  }
}

/** Persist a per-runtime consent decision, merging with any existing state. */
export async function writeRuntimeConsent(
  kind: ManagedRuntimeKind,
  decision: RuntimeConsentDecision,
  log: PinoLogger,
  home: string = okHomeDir(),
): Promise<void> {
  try {
    const current = await readRuntimeConsent(home);
    const next = { version: 1, ...current, [kind]: decision, updatedAt: Date.now() };
    await tracedMkdir(home, { recursive: true });
    await tracedWriteFile(join(home, CONSENT_FILE), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    // Non-fatal: a failed persist just means we re-ask next time.
    log.warn({ err, kind }, '[managed-runtime] consent persist failed');
  }
}
