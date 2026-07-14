/**
 * SSH transport for desktop-hosted remote projects.
 *
 * The renderer never receives SSH credentials or arbitrary command arguments.
 * This module accepts an allowlisted, non-secret machine record and delegates
 * authentication, host-key verification, ProxyJump, and agent use to the
 * system OpenSSH client. Every local process is spawned with `shell: false`;
 * remote shell strings are built here from fixed commands and POSIX-quoted
 * data. The sole intentional command input is the consent-gated terminal
 * `launchCommand`, matching the existing local PTY surface.
 *
 * Effects are injected so the protocol and lifecycle can be tested without a
 * real SSH daemon, network socket, or child process.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

import {
  isSafeSshDestination,
  PROTOCOL_VERSION,
  type RemoteDirectoryListing,
  type SshConnectionTestResult,
  type SshMachine,
} from '@inkeep/open-knowledge-core';
import { MIN_GIT_VERSION, RUNTIME_VERSION } from '@inkeep/open-knowledge-server';

export const REMOTE_READY_MARKER = 'OK_REMOTE_READY ';
export const REMOTE_ERROR_MARKER = 'OK_REMOTE_ERROR ';
export const REMOTE_INSPECT_MARKER = 'OK_REMOTE_INSPECT ';
export const REMOTE_DIRECTORIES_MARKER = 'OK_REMOTE_DIRECTORIES ';
export const REMOTE_TEST_MARKER = 'OK_REMOTE_TEST_V1 ';
export const REMOTE_COMMAND_MARKER = 'OK_REMOTE_COMMAND_V1 ';
export const REMOTE_TERMINAL_CONSENT_MARKER = 'OK_REMOTE_TERMINAL_CONSENT ';
export const REMOTE_COMPANION_MARKER = 'OK_REMOTE_COMPANION_V1 ';
export const REMOTE_TUNNEL_READY_MARKER = 'OK_REMOTE_TUNNEL_READY ';

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 12_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_FETCH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_MARKER_BYTES = 16 * 1024;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_MACHINE_NAME_LENGTH = 256;
const MAX_HOST_LENGTH = 512;
const MAX_REMOTE_PATH_LENGTH = 16 * 1024;
const MAX_RUNTIME_VERSION_LENGTH = 128;
const MAX_DIRECTORY_ENTRIES = 10_000;
const REMOTE_INSTALL_ERROR =
  'OpenKnowledge could not install remote support. Ensure the SSH home is writable and `~/.ok` is owned by that user, is not a symlink, and is not group- or world-writable.';

function minimumGitMajorMinor(): readonly [number, number] {
  const [major, minor] = MIN_GIT_VERSION.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`Invalid MIN_GIT_VERSION: ${MIN_GIT_VERSION}`);
  }
  return [major as number, minor as number];
}

const [MIN_GIT_MAJOR, MIN_GIT_MINOR] = minimumGitMajorMinor();

/** Absolute on Unix so a packaged app does not depend on its sanitized PATH. */
export const DEFAULT_SSH_PATH = process.platform === 'win32' ? 'ssh.exe' : '/usr/bin/ssh';

export type RemoteProjectErrorCode =
  | 'invalid-machine'
  | 'invalid-path'
  | 'ssh-unavailable'
  | 'ssh-failed'
  | 'timeout'
  | 'output-limit'
  | 'invalid-response'
  | 'protocol-mismatch'
  | 'unsupported-platform'
  | 'prerequisite-missing'
  | 'prerequisite-outdated'
  | 'companion-install-failed'
  | 'local-port-failed'
  | 'tunnel-failed'
  | 'project-uninitialized'
  | 'project-initialize-failed'
  | 'config-invalid'
  | 'content-dir-outside-project'
  | 'startup-failed';

/**
 * Safe error surfaced by this transport. `message` never embeds child output,
 * machine destinations, or project paths. `diagnostic` is private transport
 * input used only to map a connection-test failure to generic UI copy.
 */
export class RemoteProjectError extends Error {
  readonly code: RemoteProjectErrorCode;
  readonly diagnostic?: string;

  constructor(
    code: RemoteProjectErrorCode,
    message: string,
    options?: { cause?: unknown; diagnostic?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RemoteProjectError';
    this.code = code;
    this.diagnostic = options?.diagnostic;
  }
}

export interface RemoteReadyPayloadV1 {
  readonly v: 1;
  readonly nonce: string;
  readonly port: number;
  readonly projectPath: string;
  readonly platform: 'darwin' | 'linux';
  readonly pathSeparator: '/';
  readonly protocolVersion: number;
  readonly runtimeVersion: string;
  readonly capabilities: readonly string[];
  readonly owned: true;
}

export interface RemoteProjectInspection {
  readonly selectedPath: string;
  readonly projectPath: string;
  readonly initialized: boolean;
}

export interface RemoteProjectSession {
  readonly localPort: number;
  readonly apiOrigin: string;
  readonly collabUrl: string;
  readonly projectPath: string;
  readonly platform: 'darwin' | 'linux';
  readonly pathSeparator: '/';
  readonly owned: true;
  /** Hash of the effective OpenSSH destination/config used for this session. */
  readonly connectionFingerprint: string;
  /**
   * Idempotently closes only this session's local port-forward process.
   */
  closeTunnel(): void;
  /**
   * Idempotently closes only this session's owned remote companion process.
   */
  closeServer(): void;
  /** Idempotently closes both this session's tunnel and server process. */
  close(): void;
}

interface RemoteProcessStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

interface RemoteProcessStdin {
  end(data?: Uint8Array): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

/** Minimal child-process surface used by the transport and its test doubles. */
export interface RemoteChildProcess {
  readonly stdin: RemoteProcessStdin | null;
  readonly stdout: RemoteProcessStream | null;
  readonly stderr: RemoteProcessStream | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RemoteSpawnOptions {
  readonly shell: false;
  readonly stdio: readonly ['ignore' | 'pipe', 'pipe', 'pipe'];
  readonly windowsHide: true;
}

export type RemoteSpawn = (
  file: string,
  args: readonly string[],
  options: RemoteSpawnOptions,
) => RemoteChildProcess;

interface RemoteFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(maxBytes: number): Promise<string>;
}

export type RemoteFetch = (
  url: string,
  init: { readonly method: 'GET'; readonly signal: AbortSignal; readonly redirect: 'error' },
) => Promise<RemoteFetchResponse>;

export interface RemoteProjectServiceDeps {
  readonly spawn?: RemoteSpawn;
  readonly fetch?: RemoteFetch;
  readonly allocateLocalPort?: () => Promise<number>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Cryptographically random per-command challenge. Injectable for tests. */
  readonly createNonce?: () => string;
  readonly sshPath?: string;
  readonly expectedProtocolVersion?: number;
  readonly connectTimeoutSeconds?: number;
  readonly commandTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly tunnelReadyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxMarkerBytes?: number;
  /** Grace after closing an owned server's stdin before SIGTERM fallback. */
  readonly shutdownGraceMs?: number;
  /** Test seam for the local `ssh -G` forwarding-policy preflight. */
  readonly inspectTunnelConfig?: (machine: SshMachine) => Promise<string>;
  /** Packaged single-file companion. Production passes its Resources path. */
  readonly remoteCompanionPath?: string;
  /** Test seam for loading the packaged companion without filesystem IO. */
  readonly loadRemoteCompanion?: () => Promise<Uint8Array>;
  /** Test seam for cases that exercise transport behavior, not installation. */
  readonly ensureRemoteCompanion?: (machine: SshMachine) => Promise<string>;
}

interface ManagedProcess {
  readonly child: RemoteChildProcess;
  readonly state: {
    ended: boolean;
    error: Error | null;
    code: number | null;
    diagnostic: string;
  };
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type RemoteMachinePrerequisiteStatus =
  | 'ok'
  | 'platform-unsupported'
  | 'node-missing'
  | 'node-too-old'
  | 'git-missing'
  | 'git-too-old';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REMOTE_NONCE = /^[A-Za-z0-9_-]{43}$/;

export function createRemoteNonce(): string {
  return randomBytes(32).toString('base64url');
}

function validateRemoteNonce(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_NONCE.test(value)) {
    throw new RemoteProjectError('invalid-response', 'Remote command nonce is invalid.');
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: validating IPC/child-process text.
const CONTROL_CHARACTER = /[\x00-\x1F\x7F]/;

function boundedTrimmedText(
  value: unknown,
  field: string,
  maxLength: number,
  code: RemoteProjectErrorCode,
): string {
  if (typeof value !== 'string') {
    throw new RemoteProjectError(code, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || CONTROL_CHARACTER.test(trimmed)) {
    throw new RemoteProjectError(code, `${field} is invalid.`);
  }
  return trimmed;
}

/** Validate untrusted wire text without changing filesystem-significant spaces. */
function boundedWireText(
  value: unknown,
  field: string,
  maxLength: number,
  code: RemoteProjectErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new RemoteProjectError(code, `${field} is invalid.`);
  }
  return value;
}

function boundedCanonicalRemotePath(value: unknown, field: string): string {
  const path = boundedWireText(value, field, MAX_REMOTE_PATH_LENGTH, 'invalid-response');
  if (!path.startsWith('/')) {
    throw new RemoteProjectError('invalid-response', `${field} is not an absolute path.`);
  }
  return path;
}

/**
 * Validate and copy the non-secret persisted machine shape. Unknown keys are
 * rejected rather than forwarded, preventing a future renderer payload from
 * smuggling passwords, identity paths, ProxyCommand, or arbitrary SSH args.
 */
export function validateSshMachine(value: unknown): SshMachine {
  if (!isRecord(value)) {
    throw new RemoteProjectError('invalid-machine', 'SSH machine must be an object.');
  }
  const allowed = new Set(['id', 'name', 'host', 'port']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RemoteProjectError('invalid-machine', 'SSH machine contains unsupported fields.');
  }

  const id = boundedTrimmedText(value.id, 'Machine id', MAX_MACHINE_ID_LENGTH, 'invalid-machine');
  const name = boundedTrimmedText(
    value.name,
    'Machine name',
    MAX_MACHINE_NAME_LENGTH,
    'invalid-machine',
  );
  const host = boundedTrimmedText(value.host, 'SSH host', MAX_HOST_LENGTH, 'invalid-machine');
  if (value.host !== host || !isSafeSshDestination(host)) {
    throw new RemoteProjectError('invalid-machine', 'SSH host is unsafe.');
  }

  const port = value.port;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535)
  ) {
    throw new RemoteProjectError('invalid-machine', 'SSH port must be between 1 and 65535.');
  }
  return port === undefined ? { id, name, host } : { id, name, host, port: port as number };
}

/** Accept only POSIX absolute paths or a home-relative `~` / `~/...` path. */
export function validateRemoteProjectPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new RemoteProjectError('invalid-path', 'Remote project path must be a string.');
  }
  if (
    value.length === 0 ||
    value.length > MAX_REMOTE_PATH_LENGTH ||
    value.includes('\0') ||
    CONTROL_CHARACTER.test(value) ||
    !(value.startsWith('/') || value === '~' || value.startsWith('~/'))
  ) {
    throw new RemoteProjectError(
      'invalid-path',
      'Remote project path must be absolute or start with ~/.',
    );
  }
  return value;
}

/** POSIX single-quote encoding. Safe for an arbitrary non-NUL string. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Run a fixed command through the remote user's configured login-interactive
 * shell so every operation sees the same PATH as the built-in terminal. This
 * is important for nvm and zsh setups that initialize PATH from interactive
 * startup files. The SSH server's shell interprets the outer command;
 * `innerCommand` is POSIX-quoted into exactly one `-c` value.
 */
export function buildPosixLoginShellCommand(innerCommand: string): string {
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(innerCommand)}`;
}

function emitRemoteTestStatus(nonce: string, status: RemoteMachinePrerequisiteStatus): string {
  return `printf '%s\\n' ${quotePosix(`${REMOTE_TEST_MARKER}${JSON.stringify({ v: 1, nonce, status })}`)}`;
}

/**
 * Fixed prerequisite probe used when adding an SSH machine. Desktop installs
 * its own companion, so the remote PATH only needs Node.js and Git. The probe
 * checks the actual login-interactive PATH used by remote terminals and emits
 * one bounded status marker instead of forwarding tool output to the renderer.
 */
export function buildRemoteMachineTestCommand(nonceValue: unknown): string {
  const nonce = validateRemoteNonce(nonceValue);
  const script = [
    `platform=$(uname -s 2>/dev/null || true)`,
    `case "$platform" in Darwin|Linux) ;; *) ${emitRemoteTestStatus(nonce, 'platform-unsupported')}; exit 0;; esac`,
    `if ! command -v node >/dev/null 2>&1; then ${emitRemoteTestStatus(nonce, 'node-missing')}; exit 0; fi`,
    `node_major=$(node -p ${quotePosix('process.versions.node.split(".")[0]')} 2>/dev/null)`,
    `case "$node_major" in ''|*[!0-9]*) ${emitRemoteTestStatus(nonce, 'node-missing')}; exit 0;; esac`,
    `if [ "$node_major" -lt 24 ]; then ${emitRemoteTestStatus(nonce, 'node-too-old')}; exit 0; fi`,
    `if ! command -v git >/dev/null 2>&1; then ${emitRemoteTestStatus(nonce, 'git-missing')}; exit 0; fi`,
    `git_version=$(LC_ALL=C git --version 2>/dev/null); git_version=\${git_version#git version }`,
    `git_major=\${git_version%%.*}; git_rest=\${git_version#*.}; git_minor=\${git_rest%%.*}`,
    `case "$git_major" in ''|*[!0-9]*) ${emitRemoteTestStatus(nonce, 'git-missing')}; exit 0;; esac`,
    `case "$git_minor" in ''|*[!0-9]*) ${emitRemoteTestStatus(nonce, 'git-missing')}; exit 0;; esac`,
    `if [ "$git_major" -lt ${MIN_GIT_MAJOR} ] || { [ "$git_major" -eq ${MIN_GIT_MAJOR} ] && [ "$git_minor" -lt ${MIN_GIT_MINOR} ]; }; then ${emitRemoteTestStatus(nonce, 'git-too-old')}; exit 0; fi`,
    emitRemoteTestStatus(nonce, 'ok'),
  ].join('\n');
  return buildPosixLoginShellCommand(script);
}

export function parseRemoteMachineTest(
  stdout: string,
  expectedNonce: string,
  maxMarkerBytes: number = DEFAULT_MAX_MARKER_BYTES,
): RemoteMachinePrerequisiteStatus {
  const value = matchingRemoteFrame(stdout, REMOTE_TEST_MARKER, expectedNonce, maxMarkerBytes);
  if (!value || !hasExactKeys(value, ['v', 'nonce', 'status']) || value.v !== 1) {
    throw new RemoteProjectError('invalid-response', 'Remote prerequisite response was invalid.');
  }
  const status = value.status;
  if (
    status !== 'ok' &&
    status !== 'platform-unsupported' &&
    status !== 'node-missing' &&
    status !== 'node-too-old' &&
    status !== 'git-missing' &&
    status !== 'git-too-old'
  ) {
    throw new RemoteProjectError('invalid-response', 'Remote prerequisite response was invalid.');
  }
  return status;
}

const REMOTE_COMPANION_DIGEST = /^[a-f0-9]{64}$/;

function validateRemoteCompanionDigest(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_COMPANION_DIGEST.test(value)) {
    throw new RemoteProjectError('invalid-response', 'Remote companion identity is invalid.');
  }
  return value;
}

function remoteCompanionPathExpression(digestValue: unknown): string {
  const digest = validateRemoteCompanionDigest(digestValue);
  return `"$HOME/.ok/remote/servers/${digest}/remote-companion.mjs"`;
}

/**
 * Read-only installation probe. Node performs lstat/ownership/mode/hash checks
 * so a symlink or group-writable replacement is never executed as trusted
 * Desktop code. Missing or stale content is repaired by the upload step.
 */
export const REMOTE_COMPANION_PROBE_NODE_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = ${JSON.stringify(REMOTE_COMPANION_MARKER)};
const digest = process.argv[1];
const nonce = process.argv[2];
const home = process.env.HOME;
function ownedByUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}
function safeDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByUser(stat) && (stat.mode & 0o022) === 0;
}
function privateDirectory(stat) {
  return safeDirectory(stat) && (stat.mode & 0o777) === 0o700;
}
async function validInstallation(home, digest) {
  const okDir = path.join(home, '.ok');
  const remoteDir = path.join(okDir, 'remote');
  const serversDir = path.join(remoteDir, 'servers');
  const targetDir = path.join(serversDir, digest);
  const file = path.join(targetDir, 'remote-companion.mjs');
  try {
    for (const dir of [home, okDir]) {
      if (!safeDirectory(await fs.lstat(dir))) throw new Error('unsafe managed directory');
    }
    for (const dir of [remoteDir, serversDir, targetDir]) {
      if (!privateDirectory(await fs.lstat(dir))) throw new Error('unsafe private directory');
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedByUser(stat) || (stat.mode & 0o022) !== 0) {
      throw new Error('unsafe managed file');
    }
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') === digest;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
(async () => {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !home || !path.isAbsolute(home) || home === path.parse(home).root) {
    throw new Error('unsafe home directory');
  }
  const status = (await validInstallation(home, digest)) ? 'ready' : 'missing';
  process.stdout.write(MARKER + JSON.stringify({ v: 1, nonce, status }) + '\n');
})().catch(() => {
  process.stderr.write('OK_REMOTE_COMPANION_PROBE_ERROR\n');
  process.exitCode = 1;
});
`.trim();

/**
 * Permission-safe user install. The payload arrives on stdin, is bounded and
 * SHA-256 verified, then lands through a private staging directory + atomic
 * rename. No sudo, shell profile, PATH, npm directory, or project file changes.
 */
export const REMOTE_COMPANION_INSTALL_NODE_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MARKER = ${JSON.stringify(REMOTE_COMPANION_MARKER)};
const digest = process.argv[1];
const expectedBytes = Number(process.argv[2]);
const nonce = process.argv[3];
const home = process.env.HOME;
let stage = null;
function ownedByUser(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}
function safeDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByUser(stat) && (stat.mode & 0o022) === 0;
}
async function assertOwnedDirectory(dir, create, makePrivate) {
  let stat;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    if (!create) throw error;
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (mkdirError) {
      if (!mkdirError || mkdirError.code !== 'EEXIST') throw mkdirError;
    }
    stat = await fs.lstat(dir);
  }
  if (!safeDirectory(stat)) throw new Error('managed directory is unsafe');
  if (makePrivate && (stat.mode & 0o777) !== 0o700) {
    await fs.chmod(dir, 0o700);
    stat = await fs.lstat(dir);
    if (!safeDirectory(stat) || (stat.mode & 0o777) !== 0o700) {
      throw new Error('managed directory permissions are unsafe');
    }
  }
}
async function readPayload() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > expectedBytes) throw new Error('payload exceeded declared size');
    chunks.push(value);
  }
  if (bytes !== expectedBytes) throw new Error('payload size mismatch');
  const payload = Buffer.concat(chunks, bytes);
  if (crypto.createHash('sha256').update(payload).digest('hex') !== digest) {
    throw new Error('payload digest mismatch');
  }
  return payload;
}
async function validTarget(dir, file) {
  try {
    const dirStat = await fs.lstat(dir);
    if (!safeDirectory(dirStat) || (dirStat.mode & 0o777) !== 0o700) {
      throw new Error('target directory is unsafe');
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedByUser(stat) || (stat.mode & 0o022) !== 0) {
      throw new Error('target file is unsafe');
    }
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') === digest;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
(async () => {
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error('invalid install metadata');
  }
  if (!home || !path.isAbsolute(home) || home === path.parse(home).root) {
    throw new Error('unsafe home directory');
  }
  const payload = await readPayload();
  const okDir = path.join(home, '.ok');
  const remoteDir = path.join(okDir, 'remote');
  const serversDir = path.join(remoteDir, 'servers');
  const targetDir = path.join(serversDir, digest);
  const targetFile = path.join(targetDir, 'remote-companion.mjs');
  await assertOwnedDirectory(home, false, false);
  await assertOwnedDirectory(okDir, true, false);
  await assertOwnedDirectory(remoteDir, true, true);
  await assertOwnedDirectory(serversDir, true, true);
  if (await validTarget(targetDir, targetFile)) {
    await fs.chmod(targetFile, 0o600);
    process.stdout.write(MARKER + JSON.stringify({ v: 1, nonce, status: 'ready' }) + '\n');
    return;
  }
  try {
    const targetStat = await fs.lstat(targetDir);
    if (!safeDirectory(targetStat)) {
      throw new Error('target directory is unsafe');
    }
    await fs.rm(targetDir, { recursive: true, force: false });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  stage = await fs.mkdtemp(path.join(serversDir, '.' + digest + '-'));
  await fs.chmod(stage, 0o700);
  const stagedFile = path.join(stage, 'remote-companion.mjs');
  const handle = await fs.open(stagedFile, 'wx', 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(stagedFile, 0o600);
  try {
    await fs.rename(stage, targetDir);
    stage = null;
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY')) throw error;
    await fs.rm(stage, { recursive: true, force: true });
    stage = null;
    if (!(await validTarget(targetDir, targetFile))) throw new Error('concurrent install was invalid');
  }
  process.stdout.write(MARKER + JSON.stringify({ v: 1, nonce, status: 'installed' }) + '\n');
})().catch(async () => {
  if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  process.stderr.write('OK_REMOTE_COMPANION_INSTALL_ERROR\n');
  process.exitCode = 1;
});
`.trim();

export function buildRemoteCompanionProbeCommand(
  digestValue: unknown,
  nonceValue: unknown,
): string {
  const digest = validateRemoteCompanionDigest(digestValue);
  const nonce = validateRemoteNonce(nonceValue);
  return buildPosixLoginShellCommand(
    `node -e ${quotePosix(REMOTE_COMPANION_PROBE_NODE_SCRIPT)} ${quotePosix(digest)} ${quotePosix(nonce)}`,
  );
}

export function buildRemoteCompanionInstallCommand(
  digestValue: unknown,
  byteLength: number,
  nonceValue: unknown,
): string {
  const digest = validateRemoteCompanionDigest(digestValue);
  const nonce = validateRemoteNonce(nonceValue);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new RemoteProjectError('invalid-response', 'Remote companion size is invalid.');
  }
  return buildPosixLoginShellCommand(
    `node -e ${quotePosix(REMOTE_COMPANION_INSTALL_NODE_SCRIPT)} ${quotePosix(digest)} ${quotePosix(String(byteLength))} ${quotePosix(nonce)}`,
  );
}

export function parseRemoteCompanionStatus(
  stdout: string,
  expectedNonce: string,
): 'ready' | 'missing' | 'installed' {
  const value = matchingRemoteFrame(
    stdout,
    REMOTE_COMPANION_MARKER,
    expectedNonce,
    DEFAULT_MAX_MARKER_BYTES,
  );
  if (!value || !hasExactKeys(value, ['v', 'nonce', 'status']) || value.v !== 1) {
    throw new RemoteProjectError('invalid-response', 'Remote companion response was invalid.');
  }
  const status = value.status;
  if (status === 'ready' || status === 'missing' || status === 'installed') return status;
  throw new RemoteProjectError('invalid-response', 'Remote companion response was invalid.');
}

const REMOTE_EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function validateRemoteExecutableName(value: unknown): string {
  if (typeof value !== 'string' || !REMOTE_EXECUTABLE_NAME.test(value)) {
    throw new RemoteProjectError('invalid-response', 'Remote executable name is invalid.');
  }
  return value;
}

export function buildIsCommandAvailableCommand(binValue: unknown, nonceValue: unknown): string {
  const bin = validateRemoteExecutableName(binValue);
  const nonce = validateRemoteNonce(nonceValue);
  const inner = [
    `if command -v ${quotePosix(bin)} >/dev/null 2>&1; then`,
    `  printf '%s\\n' ${quotePosix(`${REMOTE_COMMAND_MARKER}${JSON.stringify({ v: 1, nonce, available: true })}`)}`,
    'else',
    `  printf '%s\\n' ${quotePosix(`${REMOTE_COMMAND_MARKER}${JSON.stringify({ v: 1, nonce, available: false })}`)}`,
    'fi',
  ].join('\n');
  return buildPosixLoginShellCommand(inner);
}

function parseRemoteCommandAvailability(
  stdout: string,
  expectedNonce: string,
  maxMarkerBytes: number,
): boolean {
  const value = matchingRemoteFrame(stdout, REMOTE_COMMAND_MARKER, expectedNonce, maxMarkerBytes);
  if (
    !value ||
    !hasExactKeys(value, ['v', 'nonce', 'available']) ||
    value.v !== 1 ||
    typeof value.available !== 'boolean'
  ) {
    throw new RemoteProjectError('invalid-response', 'Remote command probe was invalid.');
  }
  return value.available;
}

function remotePathShellExpression(remotePath: string): string {
  const path = validateRemoteProjectPath(remotePath);
  if (path === '~' || path === '~/') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${quotePosix(path.slice(2))}`;
  return quotePosix(path);
}

/** Fixed, argument-safe remote command used to inspect Desktop's companion project state. */
export function buildRemoteInspectCommand(
  remotePath: string,
  digestValue: unknown,
  nonceValue: unknown,
): string {
  const companion = remoteCompanionPathExpression(digestValue);
  const nonce = validateRemoteNonce(nonceValue);
  const inner = `cd ${remotePathShellExpression(remotePath)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings ${companion} --nonce ${quotePosix(nonce)} inspect`;
  return buildPosixLoginShellCommand(inner);
}

/** Fixed, argument-safe remote command used to launch Desktop's companion. */
export function buildRemoteServeCommand(
  remotePath: string,
  digestValue: unknown,
  options: {
    readonly initialize: boolean;
    readonly nonce: string;
    readonly waitForOwnerExit?: boolean;
  },
): string {
  const { initialize, nonce: nonceValue, waitForOwnerExit = false } = options;
  if (typeof initialize !== 'boolean' || typeof waitForOwnerExit !== 'boolean') {
    throw new RemoteProjectError('invalid-response', 'Remote initialization choice is invalid.');
  }
  if (initialize && waitForOwnerExit) {
    throw new RemoteProjectError(
      'invalid-response',
      'Remote initialization cannot replace a running project.',
    );
  }
  const nonce = validateRemoteNonce(nonceValue);
  const path = validateRemoteProjectPath(remotePath);
  if (initialize && !path.startsWith('/')) {
    throw new RemoteProjectError(
      'invalid-path',
      'Remote initialization requires the canonical absolute folder path returned by inspection.',
    );
  }
  const expectedPath = Buffer.from(path, 'utf8').toString('base64url');
  if (initialize && expectedPath.length > DEFAULT_MAX_MARKER_BYTES) {
    throw new RemoteProjectError('invalid-path', 'Remote project path is too long to initialize.');
  }
  const companion = remoteCompanionPathExpression(digestValue);
  const initializeArgs = initialize
    ? ` --initialize --expected-path ${quotePosix(expectedPath)}`
    : '';
  const replacementArg = waitForOwnerExit ? ' --wait-for-owner-exit' : '';
  const inner = `cd ${remotePathShellExpression(path)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings ${companion} --nonce ${quotePosix(nonce)} serve${initializeArgs}${replacementArg}`;
  return buildPosixLoginShellCommand(inner);
}

/** Fixed remote command that re-checks the project-local terminal opt-out. */
export function buildRemoteTerminalConsentCommand(
  remotePath: string,
  digestValue: unknown,
  nonceValue: unknown,
): string {
  const companion = remoteCompanionPathExpression(digestValue);
  const nonce = validateRemoteNonce(nonceValue);
  const inner = `cd ${remotePathShellExpression(remotePath)} && OK_CONSOLE_LEVEL=silent exec node --no-warnings ${companion} --nonce ${quotePosix(nonce)} terminal-consent`;
  return buildPosixLoginShellCommand(inner);
}

/**
 * Constant Node program used by the remote folder browser. The only input is a
 * base64url JSON argument. It canonicalizes the requested directory and emits
 * exactly one versioned marker; errors are deliberately path-free.
 */
export const REMOTE_LIST_DIRECTORIES_NODE_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const MAX_ENTRIES = ${MAX_DIRECTORY_ENTRIES};
let responseNonce = '';
(async () => {
  const input = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
  if (!input || input.v !== 1 || typeof input.path !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.nonce)) throw new Error('bad input');
  const nonce = input.nonce;
  responseNonce = nonce;
  let requested = input.path;
  if (requested === '~') requested = os.homedir();
  else if (requested.startsWith('~/')) requested = path.join(os.homedir(), requested.slice(2));
  if (!path.isAbsolute(requested)) throw new Error('path must be absolute');
  const canonicalPath = await fs.realpath(requested);
  if (!(await fs.stat(canonicalPath)).isDirectory()) throw new Error('not a directory');
  const directories = [];
  let entries = 0;
  for await (const entry of await fs.opendir(canonicalPath)) {
    entries += 1;
    if (entries > MAX_ENTRIES) {
      process.stdout.write(${JSON.stringify(REMOTE_DIRECTORIES_MARKER)} + JSON.stringify({ v: 1, nonce, error: 'too-many' }) + '\n');
      return;
    }
    const childPath = path.join(canonicalPath, entry.name);
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(childPath)).isDirectory();
      } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
        isDirectory = false;
      }
    }
    if (isDirectory) directories.push({ name: entry.name, path: childPath });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(canonicalPath);
  const result = {
    v: 1,
    nonce,
    canonicalPath,
    parentPath: parent === canonicalPath ? null : parent,
    directories,
  };
  process.stdout.write(${JSON.stringify(REMOTE_DIRECTORIES_MARKER)} + JSON.stringify(result) + '\n');
})().catch(() => {
  process.stdout.write(${JSON.stringify(REMOTE_DIRECTORIES_MARKER)} + JSON.stringify({ v: 1, nonce: responseNonce, error: 'failed' }) + '\n');
});
`.trim();

export function encodeRemoteDirectoryRequest(remotePath: string, nonceValue: unknown): string {
  const path = validateRemoteProjectPath(remotePath);
  const nonce = validateRemoteNonce(nonceValue);
  return Buffer.from(JSON.stringify({ v: 1, nonce, path }), 'utf8').toString('base64url');
}

export function buildListDirectoriesCommand(remotePath: string, nonceValue: unknown): string {
  const payload = encodeRemoteDirectoryRequest(remotePath, nonceValue);
  const inner = `node -e ${quotePosix(REMOTE_LIST_DIRECTORIES_NODE_SCRIPT)} ${quotePosix(payload)}`;
  return buildPosixLoginShellCommand(inner);
}

function commonSshArgs(connectTimeoutSeconds: number): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'RemoteCommand=none',
    '-o',
    // A saved `SessionType=none` suppresses every fixed remote command,
    // including the tunnel readiness sentinel. Desktop always needs a normal
    // SSH session for probes, the remote server, terminals, and the sentinel.
    'SessionType=default',
    // Preserve config aliases, ProxyJump, identities, and agent-based auth,
    // while refusing unrelated long-lived capabilities inherited from a Host
    // block. ControlPath=none is what prevents attachment to a persistent
    // multiplex master; ControlMaster=no alone does not.
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ForwardX11Trusted=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ControlPersist=no',
    '-o',
    'Tunnel=no',
    '-o',
    'StdinNull=no',
    '-o',
    'ForkAfterAuthentication=no',
  ];
}

function portArgs(machine: SshMachine): string[] {
  return machine.port === undefined ? [] : ['-p', String(machine.port)];
}

/**
 * SSH argv for a bounded remote command. `ClearAllForwardings` prevents saved
 * config forwards from being activated by one-shot probes while retaining all
 * authentication, host, ProxyJump, and agent configuration.
 */
export function buildSshCommandArgs(
  machineValue: unknown,
  remoteCommand: string,
  connectTimeoutSeconds: number = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): string[] {
  const machine = validateSshMachine(machineValue);
  return [
    ...commonSshArgs(connectTimeoutSeconds),
    '-o',
    'ClearAllForwardings=yes',
    '-T',
    ...portArgs(machine),
    '--',
    machine.host,
    remoteCommand,
  ];
}

/** Resolve effective Host configuration before starting a long-lived tunnel. */
export function buildSshEffectiveConfigArgs(
  machineValue: unknown,
  connectTimeoutSeconds: number = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): string[] {
  const machine = validateSshMachine(machineValue);
  return [
    ...commonSshArgs(connectTimeoutSeconds),
    // Inspect the exact forwarding posture the tunnel will use. Leaving an
    // inherited `ClearAllForwardings=yes` in force can hide configured
    // forwards from `ssh -G`; the tunnel's matching `no` would then re-enable
    // them after the safety preflight.
    '-o',
    'ClearAllForwardings=no',
    '-G',
    ...portArgs(machine),
    '--',
    machine.host,
  ];
}

/**
 * Reject Host aliases that would activate unrelated configured forwards.
 * `ClearAllForwardings=yes` cannot be used by the tunnel process because it
 * also clears Desktop's explicit loopback `-L`, so `ssh -G` is the reliable
 * preflight boundary.
 */
export function assertSafeTunnelSshConfig(effectiveConfig: string): void {
  const forbidden = new Set(['localforward', 'remoteforward', 'dynamicforward']);
  for (const line of effectiveConfig.split(/\r?\n/)) {
    const key = line.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
    if (key && forbidden.has(key)) {
      throw new RemoteProjectError(
        'invalid-machine',
        'This SSH Host config defines port forwarding. Add a clean Host alias without LocalForward, RemoteForward, or DynamicForward.',
      );
    }
  }
}

/** Hash only endpoint/routing fields whose drift can redirect later SSH work. */
export function fingerprintTunnelSshConfig(effectiveConfig: string): string {
  assertSafeTunnelSshConfig(effectiveConfig);
  const identityKeys = new Set([
    'hostname',
    'user',
    'port',
    'hostkeyalias',
    'proxyjump',
    'proxycommand',
    'canonicalizehostname',
    'canonicaldomains',
  ]);
  const identity = effectiveConfig
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const key = line.split(/\s+/, 1)[0]?.toLowerCase();
      return key !== undefined && identityKeys.has(key);
    })
    .join('\n');
  if (!/(?:^|\n)hostname\s+\S+/i.test(identity) || !/(?:^|\n)port\s+\d+/i.test(identity)) {
    throw new RemoteProjectError(
      'invalid-response',
      'The system SSH client returned an invalid effective Host configuration.',
    );
  }
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

/**
 * SSH argv for the dedicated loopback-only forwarding process. The fixed
 * remote `cat` sentinel ties the session lifetime to piped stdin: if Desktop
 * closes or crashes, EOF reaches the remote command and SSH tears down the
 * forward instead of surviving as an orphaned `ssh -N` process.
 */
export function buildSshTunnelArgs(
  machineValue: unknown,
  localPort: number,
  remotePort: number,
  nonceValue: unknown,
  connectTimeoutSeconds: number = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): string[] {
  const machine = validateSshMachine(machineValue);
  const nonce = validateRemoteNonce(nonceValue);
  if (!isValidPort(localPort) || !isValidPort(remotePort)) {
    throw new RemoteProjectError('tunnel-failed', 'SSH tunnel port is invalid.');
  }
  return [
    ...commonSshArgs(connectTimeoutSeconds),
    '-o',
    // The tunnel needs Desktop's explicit -L even when the selected Host alias
    // inherits `ClearAllForwardings=yes`. The effective-config preflight uses
    // the same override and rejects every unrelated configured forward.
    'ClearAllForwardings=no',
    '-o',
    'ExitOnForwardFailure=yes',
    '-T',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...portArgs(machine),
    '--',
    machine.host,
    buildRemoteTunnelSentinelCommand(nonce),
  ];
}

export function buildRemoteTunnelSentinelCommand(nonceValue: unknown): string {
  const nonce = validateRemoteNonce(nonceValue);
  const frame = `${REMOTE_TUNNEL_READY_MARKER}${JSON.stringify({ v: 1, nonce, ready: true })}`;
  return `printf '%s\\n' ${quotePosix(frame)}; exec cat >/dev/null`;
}

/**
 * SSH argv for a docked remote terminal. `launchCommand` is the same consent-
 * gated command surface used by the local PTY host: when non-empty, the remote
 * login-interactive shell runs it and then replaces itself with a fresh login-
 * interactive shell so the tab remains usable after the agent exits.
 */
export function buildSshTerminalArgs(
  machineValue: unknown,
  remotePath: string,
  launchCommand?: string,
  connectTimeoutSeconds: number = DEFAULT_CONNECT_TIMEOUT_SECONDS,
): string[] {
  const machine = validateSshMachine(machineValue);
  const shellTail = `exec "\${SHELL:-/bin/sh}" -l -i`;
  const launch =
    launchCommand !== undefined && launchCommand.length > 0 ? `${launchCommand}; ` : '';
  const inner = `cd ${remotePathShellExpression(remotePath)} && ${launch}${shellTail}`;
  const remoteCommand = buildPosixLoginShellCommand(inner);
  return [
    ...commonSshArgs(connectTimeoutSeconds),
    '-o',
    'ClearAllForwardings=yes',
    '-tt',
    ...portArgs(machine),
    '--',
    machine.host,
    remoteCommand,
  ];
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function parseJsonObject(json: string, code: RemoteProjectErrorCode): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new RemoteProjectError(code, 'Remote response was not valid JSON.', { cause });
  }
  if (!isRecord(parsed)) {
    throw new RemoteProjectError(code, 'Remote response had an invalid shape.');
  }
  return parsed;
}

function matchingRemoteFrameLine(
  line: string,
  marker: string,
  expectedNonce: string,
  maxMarkerBytes: number,
): Record<string, unknown> | null {
  const nonce = validateRemoteNonce(expectedNonce);
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!normalized.startsWith(marker) || Buffer.byteLength(normalized, 'utf8') > maxMarkerBytes) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.slice(marker.length));
  } catch {
    return null;
  }
  return isRecord(parsed) && parsed.nonce === nonce ? parsed : null;
}

function matchingRemoteFrame(
  stdout: string,
  marker: string,
  expectedNonce: string,
  maxMarkerBytes: number,
): Record<string, unknown> | null {
  for (const line of stdout.split(/\r?\n/)) {
    const value = matchingRemoteFrameLine(line, marker, expectedNonce, maxMarkerBytes);
    if (value) return value;
  }
  return null;
}

function remoteCompanionError(code: unknown): RemoteProjectError {
  if (code === 'project-uninitialized') {
    return new RemoteProjectError(
      code,
      'The selected folder is not an OpenKnowledge project. Initialize it before opening.',
    );
  }
  if (code === 'project-initialize-failed') {
    return new RemoteProjectError(
      code,
      'OpenKnowledge could not initialize the selected remote folder. Check that it is writable and does not contain a symlinked `.ok` directory.',
    );
  }
  if (code === 'config-invalid') {
    return new RemoteProjectError(code, 'The remote project configuration is invalid.');
  }
  if (code === 'content-dir-outside-project') {
    return new RemoteProjectError(
      code,
      'The remote project content directory must stay inside the project folder.',
    );
  }
  if (code === 'startup-failed') {
    return new RemoteProjectError(code, 'The remote OpenKnowledge server could not start.');
  }
  throw new RemoteProjectError('invalid-response', 'Remote companion error was invalid.');
}

/** Parse one structured companion error frame. Non-marker lines return `null`. */
export function parseRemoteErrorLine(
  line: string,
  expectedNonce: string,
  maxMarkerBytes: number = DEFAULT_MAX_MARKER_BYTES,
): RemoteProjectError | null {
  const value = matchingRemoteFrameLine(line, REMOTE_ERROR_MARKER, expectedNonce, maxMarkerBytes);
  if (!value) return null;
  if (value.v !== 1 || !hasExactKeys(value, ['v', 'nonce', 'code'])) {
    throw new RemoteProjectError('invalid-response', 'Remote companion error was invalid.');
  }
  return remoteCompanionError(value.code);
}

function parseRemoteErrorOutput(
  stdout: string,
  expectedNonce: string,
  maxMarkerBytes: number,
): RemoteProjectError | null {
  for (const line of stdout.split(/\r?\n/)) {
    const error = parseRemoteErrorLine(line, expectedNonce, maxMarkerBytes);
    if (error) return error;
  }
  return null;
}

export function parseRemoteInspection(
  stdout: string,
  expectedNonce: string,
  maxMarkerBytes: number = DEFAULT_MAX_MARKER_BYTES,
): RemoteProjectInspection {
  const value = matchingRemoteFrame(stdout, REMOTE_INSPECT_MARKER, expectedNonce, maxMarkerBytes);
  if (!value) {
    throw new RemoteProjectError('invalid-response', 'Remote project inspection was missing.');
  }
  if (
    value.v !== 1 ||
    typeof value.initialized !== 'boolean' ||
    !hasExactKeys(value, ['v', 'nonce', 'selectedPath', 'projectPath', 'initialized'])
  ) {
    throw new RemoteProjectError('invalid-response', 'Remote project inspection was invalid.');
  }
  return {
    selectedPath: boundedCanonicalRemotePath(value.selectedPath, 'Selected remote path'),
    projectPath: boundedCanonicalRemotePath(value.projectPath, 'Remote project path'),
    initialized: value.initialized,
  };
}

/** Parse one marker line. Non-marker lines return `null`; malformed markers throw. */
export function parseRemoteReadyLine(
  line: string,
  expectedNonce: string,
  expectedProtocolVersion: number = PROTOCOL_VERSION,
  maxMarkerBytes: number = DEFAULT_MAX_MARKER_BYTES,
): RemoteReadyPayloadV1 | null {
  const value = matchingRemoteFrameLine(line, REMOTE_READY_MARKER, expectedNonce, maxMarkerBytes);
  if (!value) return null;
  if (value.v !== 1) {
    throw new RemoteProjectError('invalid-response', 'Unsupported remote readiness version.');
  }
  if (!isValidPort(value.port)) {
    throw new RemoteProjectError('invalid-response', 'Remote readiness port is invalid.');
  }
  const projectPath = boundedCanonicalRemotePath(value.projectPath, 'Remote project path');
  if (value.platform !== 'darwin' && value.platform !== 'linux') {
    throw new RemoteProjectError('protocol-mismatch', 'The remote platform is not supported.');
  }
  if (value.pathSeparator !== '/') {
    throw new RemoteProjectError(
      'protocol-mismatch',
      'The remote path separator is not supported.',
    );
  }
  if (!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1) {
    throw new RemoteProjectError('invalid-response', 'Remote protocol version is invalid.');
  }
  if (value.protocolVersion !== expectedProtocolVersion) {
    throw new RemoteProjectError(
      'protocol-mismatch',
      'The remote OpenKnowledge protocol is incompatible with this app.',
    );
  }
  const runtimeVersion = boundedWireText(
    value.runtimeVersion,
    'Remote runtime version',
    MAX_RUNTIME_VERSION_LENGTH,
    'invalid-response',
  );
  if (runtimeVersion !== RUNTIME_VERSION) {
    throw new RemoteProjectError(
      'protocol-mismatch',
      'The remote OpenKnowledge runtime is incompatible with this app.',
    );
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length !== 2 ||
    value.capabilities[0] !== 'http' ||
    value.capabilities[1] !== 'ws'
  ) {
    throw new RemoteProjectError(
      'protocol-mismatch',
      'The remote OpenKnowledge server does not support this app.',
    );
  }
  if (
    value.owned !== true ||
    !hasExactKeys(value, [
      'v',
      'nonce',
      'port',
      'projectPath',
      'platform',
      'pathSeparator',
      'protocolVersion',
      'runtimeVersion',
      'capabilities',
      'owned',
    ])
  ) {
    throw new RemoteProjectError('invalid-response', 'Remote ownership flag is invalid.');
  }
  return {
    v: 1,
    nonce: expectedNonce,
    port: value.port,
    projectPath,
    platform: value.platform,
    pathSeparator: '/',
    protocolVersion: value.protocolVersion as number,
    runtimeVersion,
    capabilities: [...value.capabilities],
    owned: true,
  };
}

function parseDirectoryPayload(
  stdout: string,
  expectedNonce: string,
  maxPayloadBytes: number,
): RemoteDirectoryListing {
  const raw = matchingRemoteFrame(
    stdout,
    REMOTE_DIRECTORIES_MARKER,
    expectedNonce,
    maxPayloadBytes,
  );
  if (!raw) {
    throw new RemoteProjectError('invalid-response', 'Remote directory response was missing.');
  }
  if (raw.v !== 1) {
    throw new RemoteProjectError('invalid-response', 'Unsupported remote directory version.');
  }
  if (raw.error === 'too-many') {
    if (!hasExactKeys(raw, ['v', 'nonce', 'error'])) {
      throw new RemoteProjectError('invalid-response', 'Remote directory response was invalid.');
    }
    throw new RemoteProjectError('output-limit', 'The remote folder contains too many entries.');
  }
  if (raw.error === 'failed') {
    if (!hasExactKeys(raw, ['v', 'nonce', 'error'])) {
      throw new RemoteProjectError('invalid-response', 'Remote directory response was invalid.');
    }
    throw new RemoteProjectError('ssh-failed', 'OpenKnowledge could not read that remote folder.');
  }
  if (raw.error !== undefined) {
    throw new RemoteProjectError('invalid-response', 'Remote directory response was invalid.');
  }
  if (!hasExactKeys(raw, ['v', 'nonce', 'canonicalPath', 'parentPath', 'directories'])) {
    throw new RemoteProjectError('invalid-response', 'Remote directory response was invalid.');
  }
  const canonicalPath = boundedCanonicalRemotePath(raw.canonicalPath, 'Canonical remote path');
  let parentPath: string | null;
  if (raw.parentPath === null) {
    parentPath = null;
  } else {
    parentPath = boundedCanonicalRemotePath(raw.parentPath, 'Remote parent path');
  }
  if (!Array.isArray(raw.directories) || raw.directories.length > MAX_DIRECTORY_ENTRIES) {
    throw new RemoteProjectError('invalid-response', 'Remote directory list is invalid.');
  }
  const directories = raw.directories.map((entry) => {
    if (!isRecord(entry)) {
      throw new RemoteProjectError('invalid-response', 'Remote directory entry is invalid.');
    }
    return {
      name: boundedWireText(entry.name, 'Remote directory name', 1024, 'invalid-response'),
      path: boundedCanonicalRemotePath(entry.path, 'Remote directory path'),
    };
  });
  return { path: canonicalPath, parentPath, directories };
}

export function parseRemoteTerminalConsent(
  stdout: string,
  expectedNonce: string,
  maxMarkerBytes: number = DEFAULT_MAX_MARKER_BYTES,
): boolean {
  const raw = matchingRemoteFrame(
    stdout,
    REMOTE_TERMINAL_CONSENT_MARKER,
    expectedNonce,
    maxMarkerBytes,
  );
  if (!raw) {
    throw new RemoteProjectError('invalid-response', 'Remote terminal consent was missing.');
  }
  if (
    raw.v !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !hasExactKeys(raw, ['v', 'nonce', 'allowed'])
  ) {
    throw new RemoteProjectError('invalid-response', 'Remote terminal consent was invalid.');
  }
  return raw.allowed;
}

/** Reserve a kernel-selected IPv4 loopback port, then release it for OpenSSH. */
function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (cause) => {
      reject(
        new RemoteProjectError('local-port-failed', 'Could not allocate a local port.', {
          cause,
        }),
      );
    });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((cause) => {
        if (cause || !isValidPort(port)) {
          reject(
            new RemoteProjectError('local-port-failed', 'Could not allocate a local port.', {
              cause,
            }),
          );
          return;
        }
        resolve(port);
      });
    });
  });
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: RemoteSpawnOptions,
): RemoteChildProcess {
  return nodeSpawn(file, [...args], {
    shell: options.shell,
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
  }) as unknown as RemoteChildProcess;
}

async function defaultFetch(
  url: string,
  init: { readonly method: 'GET'; readonly signal: AbortSignal; readonly redirect: 'error' },
): Promise<RemoteFetchResponse> {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: (maxBytes) => readBoundedResponseText(response, maxBytes),
  };
}

/** Read a fetch body without ever buffering beyond the caller's byte cap. */
export async function readBoundedResponseText(
  response: Pick<Response, 'body'>,
  maxBytes: number,
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || response.body === null) {
    throw new RemoteProjectError('invalid-response', 'Remote API response was invalid.');
  }
  const reader = response.body.getReader();
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.end();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RemoteProjectError('output-limit', 'Remote API response was too large.');
      }
      text += decoder.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isRetryableConnectionFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function decodeChunk(decoder: StringDecoder, chunk: unknown): { text: string; bytes: number } {
  const buffer = chunkToBuffer(chunk);
  return { text: decoder.write(buffer), bytes: buffer.byteLength };
}

function safeKill(child: RemoteChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Closing a process is best-effort and idempotent; it may already be gone.
  }
}

function sshTestError(error: unknown): string {
  if (!(error instanceof RemoteProjectError)) return 'Could not connect to the SSH machine.';
  const diagnostic = error.diagnostic?.toLowerCase() ?? '';
  if (error.code === 'invalid-machine') return error.message;
  if (error.code === 'unsupported-platform') return error.message;
  if (error.code === 'prerequisite-missing' || error.code === 'prerequisite-outdated') {
    return error.message;
  }
  if (error.code === 'companion-install-failed') return error.message;
  if (error.code === 'timeout' || diagnostic.includes('timed out')) {
    return 'The SSH connection timed out.';
  }
  if (diagnostic.includes('host key verification failed')) {
    return 'SSH host-key verification failed.';
  }
  if (diagnostic.includes('permission denied') || diagnostic.includes('publickey')) {
    return 'SSH authentication failed.';
  }
  if (
    diagnostic.includes('could not resolve hostname') ||
    diagnostic.includes('name or service not known')
  ) {
    return 'The SSH host could not be resolved.';
  }
  if (diagnostic.includes('connection refused')) return 'The SSH connection was refused.';
  if (error.code === 'ssh-unavailable') return 'The system SSH client is unavailable.';
  if (error.code === 'invalid-response') {
    return 'The SSH machine returned an invalid prerequisite response.';
  }
  return 'Could not connect to the SSH machine.';
}

function prerequisiteError(status: RemoteMachinePrerequisiteStatus): RemoteProjectError | null {
  if (status === 'ok') return null;
  if (status === 'platform-unsupported') {
    return new RemoteProjectError(
      'unsupported-platform',
      'OpenKnowledge remote projects support macOS and Linux SSH machines.',
    );
  }
  if (status === 'node-missing') {
    return new RemoteProjectError(
      'prerequisite-missing',
      'Install Node.js 24 or newer on the SSH machine.',
    );
  }
  if (status === 'node-too-old') {
    return new RemoteProjectError(
      'prerequisite-outdated',
      'Update Node.js on the SSH machine to version 24 or newer.',
    );
  }
  if (status === 'git-missing') {
    return new RemoteProjectError(
      'prerequisite-missing',
      `Install Git ${MIN_GIT_VERSION} or newer on the SSH machine.`,
    );
  }
  return new RemoteProjectError(
    'prerequisite-outdated',
    `Update Git on the SSH machine to version ${MIN_GIT_VERSION} or newer.`,
  );
}

/** Main-process owner of SSH probes, remote-server processes, and tunnels. */
export class RemoteProjectService {
  private readonly spawn: RemoteSpawn;
  private readonly fetch: RemoteFetch;
  private readonly allocateLocalPort: () => Promise<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createNonce: () => string;
  private readonly sshPath: string;
  private readonly expectedProtocolVersion: number;
  private readonly connectTimeoutSeconds: number;
  private readonly commandTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly tunnelReadyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxMarkerBytes: number;
  private readonly shutdownGraceMs: number;
  private readonly inspectTunnelConfig: (machine: SshMachine) => Promise<string>;
  private readonly remoteCompanionPath: string | undefined;
  private readonly loadRemoteCompanion: (() => Promise<Uint8Array>) | undefined;
  private readonly ensureRemoteCompanionOverride:
    | ((machine: SshMachine) => Promise<string>)
    | undefined;
  private remoteCompanionArtifactPromise:
    | Promise<{ readonly bytes: Uint8Array; readonly digest: string }>
    | undefined;
  private readonly remoteCompanionInstallPromises = new Map<string, Promise<string>>();

  constructor(deps: RemoteProjectServiceDeps = {}) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.fetch = deps.fetch ?? defaultFetch;
    this.allocateLocalPort = deps.allocateLocalPort ?? allocateLoopbackPort;
    this.sleep = deps.sleep ?? defaultSleep;
    this.createNonce = deps.createNonce ?? createRemoteNonce;
    this.sshPath = deps.sshPath ?? DEFAULT_SSH_PATH;
    this.expectedProtocolVersion = deps.expectedProtocolVersion ?? PROTOCOL_VERSION;
    this.connectTimeoutSeconds = Math.max(
      1,
      Math.floor(deps.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS),
    );
    this.commandTimeoutMs = Math.max(1, deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    this.installTimeoutMs = Math.max(1, deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
    this.readyTimeoutMs = Math.max(1, deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    this.tunnelReadyTimeoutMs = Math.max(
      1,
      deps.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS,
    );
    this.pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.fetchTimeoutMs = Math.max(1, deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    this.maxOutputBytes = Math.max(1024, deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.maxMarkerBytes = Math.max(256, deps.maxMarkerBytes ?? DEFAULT_MAX_MARKER_BYTES);
    this.shutdownGraceMs = Math.max(1, deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    this.inspectTunnelConfig =
      deps.inspectTunnelConfig ?? ((machine) => this.inspectEffectiveTunnelConfig(machine));
    this.remoteCompanionPath = deps.remoteCompanionPath;
    this.loadRemoteCompanion = deps.loadRemoteCompanion;
    this.ensureRemoteCompanionOverride = deps.ensureRemoteCompanion;
  }

  async testMachine(machineValue: unknown): Promise<SshConnectionTestResult> {
    try {
      const machine = validateSshMachine(machineValue);
      await this.inspectTunnelConfig(machine);
      await this.assertPrerequisites(machine);
      await this.ensureRemoteCompanion(machine);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: sshTestError(error) };
    }
  }

  async listDirectories(
    machineValue: unknown,
    remotePath: string,
  ): Promise<RemoteDirectoryListing> {
    const machine = validateSshMachine(machineValue);
    const nonce = this.nextNonce();
    const command = buildListDirectoriesCommand(remotePath, nonce);
    const result = await this.runCommand(machine, command, this.commandTimeoutMs);
    return parseDirectoryPayload(result.stdout, nonce, this.maxOutputBytes);
  }

  async isCommandAvailable(
    machineValue: unknown,
    binValue: unknown,
    expectedConnectionFingerprint?: string,
  ): Promise<boolean> {
    const machine = validateSshMachine(machineValue);
    await this.assertConnectionFingerprint(machine, expectedConnectionFingerprint);
    const nonce = this.nextNonce();
    const command = buildIsCommandAvailableCommand(binValue, nonce);
    const result = await this.runCommand(machine, command, this.commandTimeoutMs);
    return parseRemoteCommandAvailability(result.stdout, nonce, this.maxMarkerBytes);
  }

  async isTerminalAllowed(
    machineValue: unknown,
    remotePath: string,
    expectedConnectionFingerprint?: string,
  ): Promise<boolean> {
    const machine = validateSshMachine(machineValue);
    await this.assertConnectionFingerprint(machine, expectedConnectionFingerprint);
    const companionDigest = await this.ensureRemoteCompanion(machine);
    const nonce = this.nextNonce();
    const command = buildRemoteTerminalConsentCommand(remotePath, companionDigest, nonce);
    const result = await this.runCommand(machine, command, this.commandTimeoutMs, nonce);
    return parseRemoteTerminalConsent(result.stdout, nonce, this.maxMarkerBytes);
  }

  async inspectProject(
    machineValue: unknown,
    remotePath: string,
  ): Promise<RemoteProjectInspection> {
    const machine = validateSshMachine(machineValue);
    await this.assertPrerequisites(machine);
    const companionDigest = await this.ensureRemoteCompanion(machine);
    const nonce = this.nextNonce();
    const result = await this.runCommand(
      machine,
      buildRemoteInspectCommand(remotePath, companionDigest, nonce),
      this.commandTimeoutMs,
      nonce,
    );
    return parseRemoteInspection(result.stdout, nonce, this.maxMarkerBytes);
  }

  async startProject(
    machineValue: unknown,
    remotePath: string,
    options: {
      readonly initialize: boolean;
      readonly expectedConnectionFingerprint?: string;
      readonly waitForOwnerExit?: boolean;
    },
  ): Promise<RemoteProjectSession> {
    const { initialize, expectedConnectionFingerprint, waitForOwnerExit = false } = options;
    const machine = validateSshMachine(machineValue);
    const connectionFingerprint = await this.inspectTunnelConfig(machine);
    if (
      expectedConnectionFingerprint !== undefined &&
      connectionFingerprint !== expectedConnectionFingerprint
    ) {
      throw new RemoteProjectError(
        'invalid-machine',
        'This SSH Host configuration changed after the project opened. Close and reopen the project before reconnecting remote tools.',
      );
    }
    if (typeof initialize !== 'boolean' || typeof waitForOwnerExit !== 'boolean') {
      throw new RemoteProjectError('invalid-response', 'Remote initialization choice is invalid.');
    }
    await this.assertPrerequisites(machine);
    const companionDigest = await this.ensureRemoteCompanion(machine);
    const nonce = this.nextNonce();
    const command = buildRemoteServeCommand(remotePath, companionDigest, {
      initialize,
      nonce,
      waitForOwnerExit,
    });
    let server: ManagedProcess | undefined;
    let tunnel: ManagedProcess | undefined;
    try {
      server = this.spawnManaged(
        buildSshCommandArgs(machine, command, this.connectTimeoutSeconds),
        'pipe',
      );
      const ready = await this.waitForReady(server.child, nonce);
      if (server.state.ended || server.state.error) {
        throw new RemoteProjectError('ssh-failed', 'Remote OpenKnowledge server exited.');
      }

      const localPort = await this.allocateLocalPort();
      if (!isValidPort(localPort)) {
        throw new RemoteProjectError('local-port-failed', 'Could not allocate a local port.');
      }
      const tunnelNonce = this.nextNonce();
      tunnel = this.spawnManaged(
        buildSshTunnelArgs(machine, localPort, ready.port, tunnelNonce, this.connectTimeoutSeconds),
        'pipe',
      );
      await this.waitForTunnelReady(tunnel, tunnelNonce);
      const apiOrigin = `http://127.0.0.1:${localPort}`;
      await this.pollApiConfig(apiOrigin, ready.port, server, tunnel);

      let tunnelClosed = false;
      let serverClosed = false;
      const closeTunnel = (): void => {
        if (tunnelClosed) return;
        tunnelClosed = true;
        if (tunnel) this.closePipedProcess(tunnel);
      };
      const closeServer = (): void => {
        if (serverClosed) return;
        serverClosed = true;
        if (server) this.closePipedProcess(server);
      };
      return {
        localPort,
        apiOrigin,
        collabUrl: `ws://127.0.0.1:${localPort}/collab`,
        projectPath: ready.projectPath,
        platform: ready.platform,
        pathSeparator: ready.pathSeparator,
        owned: true,
        connectionFingerprint,
        closeTunnel,
        closeServer,
        close: () => {
          closeTunnel();
          closeServer();
        },
      };
    } catch (error) {
      safeKill(tunnel?.child);
      safeKill(server?.child);
      if (error instanceof RemoteProjectError) throw error;
      throw new RemoteProjectError('ssh-failed', 'Could not start the remote project.', {
        cause: error,
      });
    }
  }

  private spawnManaged(
    args: readonly string[],
    stdinMode: 'ignore' | 'pipe' = 'ignore',
  ): ManagedProcess {
    let child: RemoteChildProcess;
    try {
      child = this.spawn(this.sshPath, args, {
        shell: false,
        stdio: [stdinMode, 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      throw new RemoteProjectError('ssh-unavailable', 'The system SSH client is unavailable.', {
        cause,
      });
    }
    if (!child.stdout || !child.stderr || (stdinMode === 'pipe' && !child.stdin)) {
      safeKill(child);
      throw new RemoteProjectError('ssh-unavailable', 'The SSH client did not expose output.');
    }

    const state: ManagedProcess['state'] = {
      ended: false,
      error: null,
      code: null,
      diagnostic: '',
    };
    const diagnosticDecoder = new StringDecoder('utf8');
    let diagnosticBytes = 0;
    child.stderr.on('data', (chunk) => {
      const decoded = decodeChunk(diagnosticDecoder, chunk);
      diagnosticBytes += decoded.bytes;
      if (diagnosticBytes > this.maxOutputBytes) {
        state.diagnostic = '';
        return;
      }
      state.diagnostic += decoded.text;
    });
    // Always drain stdout. Long-lived tunnel processes should not normally
    // write to it, but a configured SSH client must never block on a full pipe.
    child.stdout.on('data', () => {});
    child.once('error', (...args) => {
      state.error = args[0] instanceof Error ? args[0] : new Error('SSH process error');
    });
    child.once('close', (...args) => {
      if (diagnosticBytes <= this.maxOutputBytes) state.diagnostic += diagnosticDecoder.end();
      state.ended = true;
      state.code = typeof args[0] === 'number' ? args[0] : null;
    });
    return { child, state };
  }

  private closePipedProcess(process: ManagedProcess): void {
    if (process.state.ended) return;
    if (!process.child.stdin) {
      safeKill(process.child);
      return;
    }
    try {
      process.child.stdin.end();
    } catch {
      safeKill(process.child);
      return;
    }
    const fallback = setTimeout(() => {
      if (!process.state.ended) safeKill(process.child);
    }, this.shutdownGraceMs);
    fallback.unref();
    process.child.once('close', () => clearTimeout(fallback));
  }

  private nextNonce(): string {
    return validateRemoteNonce(this.createNonce());
  }

  private async inspectEffectiveTunnelConfig(machine: SshMachine): Promise<string> {
    const result = await this.runSshArgs(
      buildSshEffectiveConfigArgs(machine, this.connectTimeoutSeconds),
      this.commandTimeoutMs,
    );
    return fingerprintTunnelSshConfig(result.stdout);
  }

  private async assertConnectionFingerprint(
    machine: SshMachine,
    expectedConnectionFingerprint: string | undefined,
  ): Promise<void> {
    if (expectedConnectionFingerprint === undefined) return;
    const current = await this.inspectTunnelConfig(machine);
    if (current !== expectedConnectionFingerprint) {
      throw new RemoteProjectError(
        'invalid-machine',
        'This SSH Host configuration changed after the project opened. Close and reopen the project before starting remote tools.',
      );
    }
  }

  private async companionArtifact(): Promise<{
    readonly bytes: Uint8Array;
    readonly digest: string;
  }> {
    this.remoteCompanionArtifactPromise ??= (async () => {
      let bytes: Uint8Array;
      try {
        if (this.loadRemoteCompanion) {
          bytes = await this.loadRemoteCompanion();
        } else if (this.remoteCompanionPath) {
          bytes = await readFile(this.remoteCompanionPath);
        } else {
          throw new Error('Remote companion path was not configured.');
        }
      } catch (cause) {
        throw new RemoteProjectError(
          'companion-install-failed',
          'OpenKnowledge remote support files are missing. Reinstall OpenKnowledge.',
          { cause },
        );
      }
      if (bytes.byteLength < 1) {
        throw new RemoteProjectError(
          'companion-install-failed',
          'OpenKnowledge remote support files are missing. Reinstall OpenKnowledge.',
        );
      }
      return {
        bytes,
        digest: createHash('sha256').update(bytes).digest('hex'),
      };
    })();
    return this.remoteCompanionArtifactPromise;
  }

  private async assertPrerequisites(machine: SshMachine): Promise<void> {
    const nonce = this.nextNonce();
    const result = await this.runCommand(
      machine,
      buildRemoteMachineTestCommand(nonce),
      this.commandTimeoutMs,
    );
    const error = prerequisiteError(
      parseRemoteMachineTest(result.stdout, nonce, this.maxMarkerBytes),
    );
    if (error) throw error;
  }

  private async ensureRemoteCompanion(machine: SshMachine): Promise<string> {
    if (this.ensureRemoteCompanionOverride) {
      return validateRemoteCompanionDigest(await this.ensureRemoteCompanionOverride(machine));
    }

    const artifact = await this.companionArtifact();
    const key = `${machine.id}\0${machine.host}\0${machine.port ?? ''}\0${artifact.digest}`;
    const existing = this.remoteCompanionInstallPromises.get(key);
    if (existing) return existing;
    const install = this.installRemoteCompanion(machine, artifact);
    this.remoteCompanionInstallPromises.set(key, install);
    try {
      return await install;
    } finally {
      if (this.remoteCompanionInstallPromises.get(key) === install) {
        this.remoteCompanionInstallPromises.delete(key);
      }
    }
  }

  private async installRemoteCompanion(
    machine: SshMachine,
    artifact: { readonly bytes: Uint8Array; readonly digest: string },
  ): Promise<string> {
    try {
      const probeNonce = this.nextNonce();
      const probe = await this.runCommand(
        machine,
        buildRemoteCompanionProbeCommand(artifact.digest, probeNonce),
        this.commandTimeoutMs,
      );
      if (parseRemoteCompanionStatus(probe.stdout, probeNonce) === 'ready') {
        return artifact.digest;
      }

      const installNonce = this.nextNonce();
      const install = await this.runSshArgs(
        buildSshCommandArgs(
          machine,
          buildRemoteCompanionInstallCommand(
            artifact.digest,
            artifact.bytes.byteLength,
            installNonce,
          ),
          this.connectTimeoutSeconds,
        ),
        this.installTimeoutMs,
        artifact.bytes,
      );
      const status = parseRemoteCompanionStatus(install.stdout, installNonce);
      if (status === 'ready' || status === 'installed') return artifact.digest;
    } catch (error) {
      if (
        error instanceof RemoteProjectError &&
        (error.code === 'ssh-unavailable' ||
          error.code === 'timeout' ||
          error.code === 'output-limit')
      ) {
        throw error;
      }
      throw new RemoteProjectError('companion-install-failed', REMOTE_INSTALL_ERROR, {
        cause: error,
        diagnostic: error instanceof RemoteProjectError ? error.diagnostic : undefined,
      });
    }
    throw new RemoteProjectError('companion-install-failed', REMOTE_INSTALL_ERROR);
  }

  private async runCommand(
    machine: SshMachine,
    remoteCommand: string,
    timeoutMs: number,
    expectedNonce?: string,
  ): Promise<CommandResult> {
    return this.runSshArgs(
      buildSshCommandArgs(machine, remoteCommand, this.connectTimeoutSeconds),
      timeoutMs,
      undefined,
      expectedNonce,
    );
  }

  private async runSshArgs(
    args: readonly string[],
    timeoutMs: number,
    stdin?: Uint8Array,
    expectedNonce?: string,
  ): Promise<CommandResult> {
    const managed = this.spawnManaged(args, stdin === undefined ? 'ignore' : 'pipe');
    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let byteCount = 0;
        let settled = false;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        const timer = setTimeout(() => {
          finish(
            new RemoteProjectError('timeout', 'The SSH command timed out.', {
              diagnostic: stderr,
            }),
          );
        }, timeoutMs);
        timer.unref();

        const finish = (error?: RemoteProjectError, code?: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            safeKill(managed.child);
            reject(error);
            return;
          }
          if (code !== 0) {
            try {
              const structured =
                expectedNonce === undefined
                  ? null
                  : parseRemoteErrorOutput(stdout, expectedNonce, this.maxMarkerBytes);
              if (structured) {
                reject(structured);
                return;
              }
            } catch (error) {
              reject(
                error instanceof RemoteProjectError
                  ? error
                  : new RemoteProjectError(
                      'invalid-response',
                      'Remote companion error was invalid.',
                    ),
              );
              return;
            }
            reject(
              new RemoteProjectError('ssh-failed', 'The SSH command failed.', {
                diagnostic: stderr || managed.state.diagnostic,
              }),
            );
            return;
          }
          resolve({ stdout, stderr });
        };

        const append = (target: 'stdout' | 'stderr', chunk: unknown): void => {
          if (settled) return;
          const decoded = decodeChunk(target === 'stdout' ? stdoutDecoder : stderrDecoder, chunk);
          byteCount += decoded.bytes;
          if (byteCount > this.maxOutputBytes) {
            finish(new RemoteProjectError('output-limit', 'SSH command output was too large.'));
            return;
          }
          if (target === 'stdout') stdout += decoded.text;
          else stderr += decoded.text;
        };
        managed.child.stdout?.on('data', (chunk) => append('stdout', chunk));
        managed.child.stderr?.on('data', (chunk) => append('stderr', chunk));
        managed.child.once('error', (...args) => {
          const cause = args[0] instanceof Error ? args[0] : undefined;
          finish(
            new RemoteProjectError('ssh-unavailable', 'The system SSH client failed.', {
              cause,
              diagnostic: cause?.message,
            }),
          );
        });
        managed.child.once('close', (...args) => {
          if (!settled) {
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
          }
          finish(undefined, typeof args[0] === 'number' ? args[0] : null);
        });
        if (stdin !== undefined) {
          managed.child.stdin?.on?.('error', (cause) => {
            finish(
              new RemoteProjectError('ssh-failed', 'The SSH upload failed.', {
                cause,
                diagnostic: cause.message,
              }),
            );
          });
          try {
            managed.child.stdin?.end(stdin);
          } catch (cause) {
            finish(
              new RemoteProjectError('ssh-failed', 'The SSH upload failed.', {
                cause,
                diagnostic: cause instanceof Error ? cause.message : undefined,
              }),
            );
          }
        }
      });
    } catch (error) {
      safeKill(managed.child);
      throw error;
    }
  }

  private waitForReady(
    child: RemoteChildProcess,
    expectedNonce: string,
  ): Promise<RemoteReadyPayloadV1> {
    return new Promise<RemoteReadyPayloadV1>((resolve, reject) => {
      let pending = '';
      let stderr = '';
      let byteCount = 0;
      let settled = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const timer = setTimeout(() => {
        stderr += stderrDecoder.end();
        finish(
          undefined,
          new RemoteProjectError('timeout', 'Timed out waiting for the remote server.', {
            diagnostic: stderr,
          }),
        );
      }, this.readyTimeoutMs);
      timer.unref();

      const finish = (ready?: RemoteReadyPayloadV1, error?: RemoteProjectError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          safeKill(child);
          reject(error);
        } else if (ready) {
          resolve(ready);
        }
      };

      const consumeLine = (line: string): void => {
        if (settled) return;
        try {
          const remoteError = parseRemoteErrorLine(line, expectedNonce, this.maxMarkerBytes);
          if (remoteError) {
            finish(undefined, remoteError);
            return;
          }
          const ready = parseRemoteReadyLine(
            line,
            expectedNonce,
            this.expectedProtocolVersion,
            this.maxMarkerBytes,
          );
          if (ready) finish(ready);
        } catch (error) {
          finish(
            undefined,
            error instanceof RemoteProjectError
              ? error
              : new RemoteProjectError('invalid-response', 'Remote readiness was invalid.'),
          );
        }
      };

      child.stdout?.on('data', (chunk) => {
        if (settled) return;
        const decoded = decodeChunk(stdoutDecoder, chunk);
        byteCount += decoded.bytes;
        if (byteCount > this.maxOutputBytes) {
          finish(
            undefined,
            new RemoteProjectError('output-limit', 'Remote startup output was too large.'),
          );
          return;
        }
        pending += decoded.text;
        let newline = pending.indexOf('\n');
        while (newline >= 0 && !settled) {
          consumeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk) => {
        if (settled) return;
        const decoded = decodeChunk(stderrDecoder, chunk);
        byteCount += decoded.bytes;
        if (byteCount > this.maxOutputBytes) {
          finish(
            undefined,
            new RemoteProjectError('output-limit', 'Remote startup output was too large.'),
          );
          return;
        }
        stderr += decoded.text;
      });
      child.once('error', (...args) => {
        const cause = args[0] instanceof Error ? args[0] : undefined;
        finish(
          undefined,
          new RemoteProjectError('ssh-unavailable', 'The system SSH client failed.', {
            cause,
            diagnostic: cause?.message,
          }),
        );
      });
      child.once('close', () => {
        if (!settled) {
          pending += stdoutDecoder.end();
          stderr += stderrDecoder.end();
        }
        if (pending.length > 0) consumeLine(pending);
        if (!settled) {
          finish(
            undefined,
            new RemoteProjectError('ssh-failed', 'Remote OpenKnowledge server exited.', {
              diagnostic: stderr,
            }),
          );
        }
      });
    });
  }

  private waitForTunnelReady(tunnel: ManagedProcess, expectedNonce: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let pending = '';
      let byteCount = 0;
      let settled = false;
      const decoder = new StringDecoder('utf8');
      const timer = setTimeout(() => {
        finish(
          new RemoteProjectError('tunnel-failed', 'Timed out starting the SSH tunnel.', {
            diagnostic: tunnel.state.diagnostic,
          }),
        );
      }, this.tunnelReadyTimeoutMs);
      timer.unref();

      const finish = (error?: RemoteProjectError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          safeKill(tunnel.child);
          reject(error);
        } else {
          resolve();
        }
      };
      const consumeLine = (line: string): void => {
        const frame = matchingRemoteFrameLine(
          line,
          REMOTE_TUNNEL_READY_MARKER,
          expectedNonce,
          this.maxMarkerBytes,
        );
        if (
          frame &&
          frame.v === 1 &&
          frame.ready === true &&
          hasExactKeys(frame, ['v', 'nonce', 'ready'])
        ) {
          finish();
        }
      };

      tunnel.child.stdout?.on('data', (chunk) => {
        if (settled) return;
        const decoded = decodeChunk(decoder, chunk);
        byteCount += decoded.bytes;
        if (byteCount > this.maxOutputBytes) {
          finish(new RemoteProjectError('output-limit', 'SSH tunnel output was too large.'));
          return;
        }
        pending += decoded.text;
        let newline = pending.indexOf('\n');
        while (newline >= 0 && !settled) {
          consumeLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      });
      tunnel.child.once('error', (...args) => {
        const cause = args[0] instanceof Error ? args[0] : undefined;
        finish(
          new RemoteProjectError('ssh-unavailable', 'The system SSH client failed.', {
            cause,
            diagnostic: cause?.message,
          }),
        );
      });
      tunnel.child.once('close', () => {
        if (!settled) pending += decoder.end();
        if (pending.length > 0) consumeLine(pending);
        if (!settled) {
          finish(
            new RemoteProjectError('tunnel-failed', 'The SSH tunnel exited.', {
              diagnostic: tunnel.state.diagnostic,
            }),
          );
        }
      });
    });
  }

  private async pollApiConfig(
    apiOrigin: string,
    remotePort: number,
    server: ManagedProcess,
    tunnel: ManagedProcess,
  ): Promise<void> {
    const attempts = Math.max(1, Math.ceil(this.tunnelReadyTimeoutMs / this.pollIntervalMs));
    const deadline = Date.now() + this.tunnelReadyTimeoutMs;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      if (server.state.ended || server.state.error) {
        throw new RemoteProjectError('ssh-failed', 'Remote OpenKnowledge server exited.', {
          diagnostic: server.state.diagnostic,
        });
      }
      if (tunnel.state.ended || tunnel.state.error) {
        throw new RemoteProjectError('tunnel-failed', 'The SSH tunnel exited.', {
          diagnostic: tunnel.state.diagnostic,
        });
      }
      try {
        const response = await this.fetch(`${apiOrigin}/api/config`, {
          method: 'GET',
          signal: AbortSignal.timeout(Math.max(1, Math.min(this.fetchTimeoutMs, remainingMs))),
          redirect: 'error',
        });
        if (!response.ok) {
          throw new RemoteProjectError(
            'invalid-response',
            'The remote OpenKnowledge API returned an unsuccessful response.',
          );
        }
        const text = await response.text(this.maxMarkerBytes);
        if (Buffer.byteLength(text, 'utf8') > this.maxMarkerBytes) {
          throw new RemoteProjectError('output-limit', 'Remote API response was too large.');
        }
        const body = parseJsonObject(text, 'invalid-response');
        if (
          body.port !== remotePort ||
          (typeof body.collabUrl !== 'string' && body.collabUrl !== null)
        ) {
          throw new RemoteProjectError('invalid-response', 'Remote API response was invalid.');
        }
        if (server.state.ended || server.state.error) {
          throw new RemoteProjectError('ssh-failed', 'Remote OpenKnowledge server exited.');
        }
        if (tunnel.state.ended || tunnel.state.error) {
          throw new RemoteProjectError('tunnel-failed', 'The SSH tunnel exited.');
        }
        return;
      } catch (error) {
        if (error instanceof RemoteProjectError) throw error;
        if (!isRetryableConnectionFailure(error)) {
          throw new RemoteProjectError(
            'tunnel-failed',
            'The remote OpenKnowledge API could not be reached through the SSH tunnel.',
            { cause: error },
          );
        }
      }
      if (attempt + 1 < attempts && Date.now() < deadline) {
        await this.sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
    }
    throw new RemoteProjectError('timeout', 'Timed out waiting for the SSH tunnel.');
  }
}

export function createRemoteProjectService(
  deps: RemoteProjectServiceDeps = {},
): RemoteProjectService {
  return new RemoteProjectService(deps);
}
