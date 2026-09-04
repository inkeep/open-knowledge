import { randomUUID } from 'node:crypto';
import { access, constants, readdir, stat } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { tracedMkdir, tracedRename, tracedRm } from '../fs-traced.ts';
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
import { cleanupStaleInstallArtifacts, stagedInstall } from './staged-install.ts';

export type ManagedRuntimeKind = 'node' | 'uv';

const PINNED_NODE_VERSION = 'v24.18.0';
const PINNED_UV_VERSION = '0.11.28';

const NODE_DIST_BASE = 'https://nodejs.org/dist';
const UV_RELEASE_BASE = 'https://github.com/astral-sh/uv/releases/download';

const APPROX_SIZE_MB: Record<ManagedRuntimeKind, number> = { node: 45, uv: 20 };

interface ManagedNode {
  kind: 'node';
  binDir: string;
  npxBin: string;
  cacheDir: string;
}

interface ManagedUv {
  kind: 'uv';
  binDir: string;
  uvxBin: string;
  cacheDir: string;
}

export type ManagedRuntime = ManagedNode | ManagedUv;

export interface RuntimeDescriptor {
  kind: ManagedRuntimeKind;
  displayName: string;
  provides: string;
  version: string;
  approxSizeMB: number;
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

function okHomeDir(): string {
  return join(homedir(), OK_DIR);
}

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
  fetchImpl?: typeof fetch;
  beforeCommit?: () => Promise<void>;
  commitLockTimeoutMs?: number;
}

export class RuntimeInstallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeInstallError';
  }
}

export async function cleanupManagedRuntimeStaging(
  kind: ManagedRuntimeKind,
  log: PinoLogger,
  root: string = defaultRuntimeRoot(),
): Promise<void> {
  await cleanupStaleInstallArtifacts(join(root, kind), log, '[managed-runtime]');
}

export async function quarantineManagedRuntime(
  kind: ManagedRuntimeKind,
  log: PinoLogger,
  root: string = defaultRuntimeRoot(),
): Promise<boolean> {
  const versionDir = join(root, kind, sanitizeSegment(versionOf(kind)));
  const quarantined = join(
    dirname(versionDir),
    `.install-damaged-${sanitizeSegment(versionOf(kind))}-${randomUUID()}`,
  );
  try {
    await tracedRename(versionDir, quarantined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    log.warn({ err, kind, versionDir }, '[managed-runtime] could not quarantine damaged runtime');
    return false;
  }
  log.info({ kind, versionDir }, '[managed-runtime] quarantined damaged runtime');
  await tracedRm(quarantined, { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function ensureManagedRuntime(
  kind: ManagedRuntimeKind,
  log: PinoLogger,
  opts: EnsureRuntimeOptions = {},
): Promise<ManagedRuntime> {
  const root = opts.root ?? defaultRuntimeRoot();
  const versionDir = join(root, kind, sanitizeSegment(versionOf(kind)));
  try {
    return await stagedInstall<ManagedRuntime>({
      versionDir,
      stagingLabel: sanitizeSegment(versionOf(kind)),
      findInstalled: () => findManagedRuntime(kind, root),
      prepare: async (stagingDir) => {
        const spec = artifactFor(kind);
        if (spec === null) {
          throw new RuntimeInstallError(`no ${kind} build for ${platform()}-${arch()}`);
        }
        const archivePath = join(stagingDir, spec.archiveName);
        log.info(
          { kind, version: versionOf(kind), url: spec.archiveUrl },
          '[managed-runtime] downloading runtime',
        );
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
        return extractDir;
      },
      log,
      logPrefix: '[managed-runtime]',
      logContext: { kind, version: versionOf(kind) },
      installedMessage: 'runtime installed',
      missingAfterCommitMessage: `installed ${kind} runtime not found after extract`,
      beforeCommit: opts.beforeCommit,
      commitLockTimeoutMs: opts.commitLockTimeoutMs,
    });
  } catch (err) {
    if (err instanceof RuntimeInstallError) throw err;
    throw new RuntimeInstallError(
      `installing ${kind} ${versionOf(kind)} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
