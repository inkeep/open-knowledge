import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  LOCAL_OP_PIPE_STDIO_OPTIONS,
  withHiddenWindowsConsole,
} from './child-process-windows-hide.ts';
import { isValidLockPid, type ProcessLiveness, readProcessLiveness } from './process-alive.ts';

const SPAWN_TIMEOUT_MS = 2000;
const LOCK_SCAN_MAX_DEPTH = 3;
const LOCK_SCAN_MAX_ENTRIES = 2000;
const OK_LOCK_DIR_ARG_PREFIX = '--ok-lock-dir-b64=';
const OK_PROJECT_PATH_ARG_PREFIX = '--ok-project-path=';
const LISTENER_QUERY_ARGS = ['-iTCP', '-sTCP:LISTEN', '-nP'];
const OK_PROCESS_PGREP_QUERY =
  'cli\\.mjs|open-knowledge|Open ?Knowledge(\\.app| Helper)|--ok-lock-dir-b64=|--ok-project-path=|(^|[ /])ok[ ]+(start|mcp|ui)([ ]|$)|packages/(cli|app)|hocuspocus|vite';

const OK_PROCESS_PATTERNS: RegExp[] = [
  /^open-knowledge-server(?:\s|$)/,
  /cli\.mjs/,
  /(^|[\s/])(open-knowledge|ok)\s+(start|mcp|ui)(\s|$)/,
  /Open ?Knowledge(?:\.app| Helper)/,
  /(^|[\s/])bun([\s/]).*?(run dev|packages\/app|vite|hocuspocus)/,
  /(^|[\s/])node([\s/]).*?(packages\/(cli|app)|vite|hocuspocus)/,
  /(^|\s)--ok-lock-dir-b64=/,
  /(^|\s)--ok-project-path=/,
];

function isOkProcess(command: string): boolean {
  return OK_PROCESS_PATTERNS.some((re) => re.test(command));
}

function extractMarkedLockDir(command: string): string | null {
  const token = command
    .trim()
    .split(/\s+/)
    .find((part) => part.startsWith(OK_LOCK_DIR_ARG_PREFIX));
  if (token == null) return null;
  const encoded = token.slice(OK_LOCK_DIR_ARG_PREFIX.length);
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return isAbsolute(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function extractProjectPathArg(command: string): string | null {
  const markerIdx = command.indexOf(OK_PROJECT_PATH_ARG_PREFIX);
  if (markerIdx === -1) return null;
  const valueStart = markerIdx + OK_PROJECT_PATH_ARG_PREFIX.length;
  const rest = command.slice(valueStart);
  const nextArgIdx = rest.search(/\s--/);
  const raw = (nextArgIdx === -1 ? rest : rest.slice(0, nextArgIdx)).trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : null;
}

interface OkProcessEntry {
  pid: number;
  command: string;
}

function parsePgrepOutput(output: string): OkProcessEntry[] {
  const entries: OkProcessEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const command = trimmed.slice(spaceIdx + 1);
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isOkProcess(command)) {
      entries.push({ pid, command });
    }
  }
  return entries;
}

interface ListingResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  hasStdout: boolean;
  hasStderr: boolean;
  diagnostic: string;
}

function readCommandLines(
  program: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<ListingResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      program,
      args,
      withHiddenWindowsConsole({
        ...LOCAL_OP_PIPE_STDIO_OPTIONS,
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          ...process.env,
          LC_CTYPE: process.env.LC_ALL || process.env.LC_CTYPE,
          LC_ALL: undefined,
          LC_MESSAGES: 'C',
        },
      }),
    );
    let hasStdout = false;
    let hasStderr = false;
    let diagnostic = '';
    child.once('error', reject);
    const readLines = (stream: Readable, visit: (line: string) => void) => {
      let pending = '';
      stream.once('error', reject);
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          visit(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      });
      stream.once('end', () => {
        if (pending) visit(pending);
      });
    };
    readLines(child.stdout, (line) => {
      hasStdout = true;
      onLine(line);
    });
    readLines(child.stderr, (line) => {
      hasStderr = true;
      diagnostic ||= line.trim();
    });
    child.once('close', (code, signal) => {
      resolveResult({ code, signal, timedOut: child.killed, hasStdout, hasStderr, diagnostic });
    });
  });
}

function describeListingError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${code}: ${error.message}` : error.message;
}

function describeListingResult(result: ListingResult): string {
  const completion = result.signal ? `signal ${result.signal}` : `exit status ${result.code}`;
  const ending = result.timedOut
    ? `timed out after ${SPAWN_TIMEOUT_MS} ms (${completion})`
    : completion;
  return `${ending}${result.diagnostic ? `: ${result.diagnostic}` : ''}`;
}

class PsListingError extends Error {
  readonly result: ListingResult;

  constructor(result: ListingResult) {
    super(describeListingResult(result));
    this.result = result;
  }
}

async function readPsEntries(args: string[]): Promise<OkProcessEntry[]> {
  const entries: OkProcessEntry[] = [];
  let header = true;
  const result = await readCommandLines('ps', args, (line) => {
    if (header) {
      header = false;
      return;
    }
    const trimmed = line.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return;
    const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
    const command = trimmed.slice(spaceIdx + 1).trim();
    if (!Number.isNaN(pid) && isOkProcess(command)) entries.push({ pid, command });
  });
  if (result.code !== 0 || result.signal) {
    throw new PsListingError(result);
  }
  if (header) throw new Error('no process table returned');
  return entries;
}

async function findOkProcessEntries(strict = false): Promise<OkProcessEntry[]> {
  const failures: string[] = [];
  const unix = process.platform === 'darwin' || process.platform === 'linux';
  if (!unix) {
    const pgrepResult = spawnSync(
      'pgrep',
      ['-a', '-f', OK_PROCESS_PGREP_QUERY],
      withHiddenWindowsConsole({
        encoding: 'utf-8',
        timeout: SPAWN_TIMEOUT_MS,
      }),
    );

    if (!pgrepResult.error && (pgrepResult.status === 0 || pgrepResult.status === 1)) {
      const output = pgrepResult.stdout ?? '';
      const entries = parsePgrepOutput(output);
      if (entries.length > 0 || output.trim() === '') return entries;
      failures.push('pgrep: no command rows returned');
    } else {
      failures.push(
        `pgrep: ${pgrepResult.error ? describeListingError(pgrepResult.error) : `exit status ${pgrepResult.status}`}`,
      );
    }
  }

  const formats =
    process.platform === 'linux'
      ? [
          ['-ww', '-A', '-o', 'pid,cmdline'],
          ['-ww', '-A', '-o', 'pid,args'],
          ['-A', '-o', 'pid,args'],
        ]
      : unix
        ? [['-ww', '-A', '-o', 'pid,args']]
        : [['-axo', 'pid,command']];
  for (const args of formats) {
    try {
      return await readPsEntries(args);
    } catch (error) {
      failures.push(`ps (${args.join(' ')}): ${describeListingError(error)}`);
      const unsupportedFormat =
        error instanceof PsListingError &&
        error.result.code === 1 &&
        !error.result.signal &&
        !error.result.hasStdout;
      if (!unsupportedFormat) break;
    }
  }
  if (strict) throw new Error(`Could not enumerate processes: ${failures.join('; ')}`);
  return [];
}

export async function findOkProcessPids(): Promise<number[]> {
  return (await findOkProcessEntries()).map((e) => e.pid);
}

export function extractOkBinaryPath(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith('@')) continue;
    const base = basename(token);
    if (base === 'open-knowledge' || base === 'ok') return token;
    if (
      token.endsWith('/packages/cli/src/cli.ts') ||
      token.endsWith('/packages/cli/dist/cli.mjs')
    ) {
      return token;
    }
    if (base === 'cli.mjs' || base === 'cli.ts') return token;
  }
  return null;
}

export function processCommand(pid: number): string | null {
  const result = spawnSync(
    'ps',
    ['-p', String(pid), '-o', 'command='],
    withHiddenWindowsConsole({
      encoding: 'utf-8',
      timeout: SPAWN_TIMEOUT_MS,
    }),
  );

  if (result.error != null || !result.stdout) return null;
  return result.stdout.trim() || null;
}

export interface ProcessUsage {
  cpuPercent: number;
  memPercent: number;
}

export function processUsage(pid: number): ProcessUsage | null {
  const result = spawnSync(
    'ps',
    ['-p', String(pid), '-o', '%cpu=,%mem='],
    withHiddenWindowsConsole({
      encoding: 'utf-8',
      timeout: SPAWN_TIMEOUT_MS,
    }),
  );

  if (result.error != null || !result.stdout) return null;
  const [cpuRaw, memRaw] = result.stdout.trim().split(/\s+/);
  const cpuPercent = Number.parseFloat(cpuRaw ?? '');
  const memPercent = Number.parseFloat(memRaw ?? '');
  if (Number.isNaN(cpuPercent) || Number.isNaN(memPercent)) return null;
  return { cpuPercent, memPercent };
}

export interface ProcessProbeFailure {
  pid: number;
  reason: string;
}

export interface ProcessProbeOptions {
  onProbeFailure?: (failure: ProcessProbeFailure) => void;
}

function renderProbeFailure(failure: ProcessProbeFailure): string {
  return `[process-scan] could not read the state of process ${failure.pid} (${failure.reason}); treating it as not defunct\n`;
}

export type ProcessState =
  | { status: 'running' }
  | { status: 'defunct' }
  | { status: 'gone' }
  | { status: 'unreadable'; reason: string };

function reportUnreadableState(
  pid: number,
  reason: string,
  options: ProcessProbeOptions,
): ProcessState {
  const failure: ProcessProbeFailure = { pid, reason };
  if (options.onProbeFailure) options.onProbeFailure(failure);
  else process.stderr.write(renderProbeFailure(failure));
  return { status: 'unreadable', reason };
}

export function readProcessState(pid: number, options: ProcessProbeOptions = {}): ProcessState {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { status: 'unreadable', reason: `no process-state query on ${process.platform}` };
  }
  try {
    const state = execFileSync(
      'ps',
      ['-p', String(pid), '-o', 'stat='],
      withHiddenWindowsConsole({
        encoding: 'utf8',
        ...LOCAL_OP_PIPE_STDIO_OPTIONS,
        timeout: SPAWN_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: 'C' },
      }),
    );
    return state.trim().startsWith('Z') ? { status: 'defunct' } : { status: 'running' };
  } catch (err: unknown) {
    if (!(err instanceof Error)) return reportUnreadableState(pid, String(err), options);
    const failure = err as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: Buffer | string | null;
    };
    const stderrText = String(failure.stderr ?? '');
    if (typeof failure.status === 'number' && stderrText.trim() === '') return { status: 'gone' };
    const diagnostic =
      stderrText
        .split('\n')
        .find((line) => line.trim() !== '')
        ?.trim() ?? '';
    return reportUnreadableState(pid, diagnostic || failure.code || failure.message, options);
  }
}

export function isDefunctProcess(pid: number, options: ProcessProbeOptions = {}): boolean {
  return readProcessState(pid, options).status === 'defunct';
}

function psAbsenceOutranksLiveness(state: ProcessState, liveness: ProcessLiveness): boolean {
  return state.status === 'gone' && liveness === 'signalable';
}

export function isLockProcessRunning(pid: number, options: ProcessProbeOptions = {}): boolean {
  const liveness = readProcessLiveness(pid);
  if (liveness === 'absent') return false;
  const state = readProcessState(pid, options);
  if (state.status === 'defunct') return false;
  return !psAbsenceOutranksLiveness(state, liveness);
}

function parsePidCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isNaN(parsed) ? null : parsed;
    } else if (line.startsWith('n') && line.length > 1 && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

function queryPidCwds(pids: readonly number[]): {
  cwds: Map<number, string>;
  queryFailed: boolean;
} {
  const result = spawnSync(
    'lsof',
    ['-p', pids.join(','), '-a', '-d', 'cwd', '-Fn'],
    withHiddenWindowsConsole({
      encoding: 'utf-8',
      timeout: SPAWN_TIMEOUT_MS,
    }),
  );
  if (result.error != null) {
    return {
      cwds: new Map(),
      queryFailed: true,
    };
  }
  return { cwds: parsePidCwds(result.stdout ?? ''), queryFailed: false };
}

export function readPidCwds(pids: readonly number[]): Map<number, string> {
  if (pids.length === 0) return new Map();
  const batched = queryPidCwds(pids);
  if (!batched.queryFailed || pids.length === 1) return batched.cwds;
  const cwds = new Map<number, string>();
  for (const pid of pids) {
    const cwd = queryPidCwds([pid]).cwds.get(pid);
    if (cwd !== undefined) cwds.set(pid, cwd);
  }
  return cwds;
}

async function readListeningPids(strict = false): Promise<number[]> {
  const pids = new Set<number>();
  let header = true;
  const result = await readCommandLines('lsof', LISTENER_QUERY_ARGS, (line) => {
    if (header) {
      header = false;
      return;
    }
    const parts = line.trim().split(/\s+/);
    const pid = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isNaN(pid)) pids.add(pid);
  });
  const noListeners = result.code === 1 && !result.hasStdout && !result.hasStderr;
  if (result.signal || result.code === null || (strict && result.code !== 0 && !noListeners)) {
    throw new Error(describeListingResult(result));
  }
  return [...pids];
}

function hasLockFile(lockDir: string): boolean {
  return existsSync(join(lockDir, 'server.lock'));
}

function addLockDirsForCwd(candidateDirs: Set<string>, cwd: string): void {
  for (const lockDir of [join(cwd, '.ok', 'local'), join(cwd, '.ok')]) {
    if (existsSync(lockDir) && hasLockFile(lockDir)) {
      candidateDirs.add(lockDir);
    }
  }
}

function addLockDirsUnderCwd(candidateDirs: Set<string>, cwd: string): void {
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (visited >= LOCK_SCAN_MAX_ENTRIES) return;
    visited++;

    addLockDirsForCwd(candidateDirs, dir);
    if (depth >= LOCK_SCAN_MAX_DEPTH) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= LOCK_SCAN_MAX_ENTRIES) return;
      if (entry === 'node_modules' || entry === '.git' || entry === 'Library') continue;
      if (entry.startsWith('.') && entry !== '.ok') continue;

      const child = join(dir, entry);
      let isDirectory = false;
      try {
        isDirectory = lstatSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(child, depth + 1);
    }
  };

  walk(cwd, 0);
}

export async function discoverLockDirs(): Promise<string[]> {
  const candidateDirs = new Set<string>();

  const okEntries = await findOkProcessEntries();
  const okCwds = readPidCwds(okEntries.map((entry) => entry.pid));
  const cwds = okEntries.map((entry) => okCwds.get(entry.pid) ?? null);

  for (const entry of okEntries) {
    const markedLockDir = extractMarkedLockDir(entry.command);
    if (markedLockDir != null && existsSync(markedLockDir)) {
      candidateDirs.add(markedLockDir);
    }

    const projectPath = extractProjectPathArg(entry.command);
    if (projectPath != null) {
      addLockDirsForCwd(candidateDirs, projectPath);
    }
  }

  for (const cwd of cwds) {
    if (cwd == null) continue;
    addLockDirsForCwd(candidateDirs, cwd);
  }

  const listeningPids = await readListeningPids().catch(() => null);
  if (listeningPids !== null) {
    const knownPidSet = new Set(okEntries.map((e) => e.pid));
    const newPids = listeningPids.filter((p) => !knownPidSet.has(p));
    const portCwdsByPid = readPidCwds(newPids);
    const portCwds = newPids.map((pid) => portCwdsByPid.get(pid) ?? null);

    for (const cwd of portCwds) {
      if (cwd == null) continue;
      addLockDirsForCwd(candidateDirs, cwd);
    }
  }

  if (candidateDirs.size === 0 || cwds.some((cwd) => cwd === '/')) {
    addLockDirsUnderCwd(candidateDirs, process.cwd());
  }

  const canonical = new Map<string, string>();
  for (const dir of candidateDirs) {
    try {
      const real = await realpath(dir);
      canonical.set(real, real);
    } catch {
      canonical.set(dir, dir);
    }
  }

  return [...canonical.values()];
}

export interface LockProcessScan {
  candidates: Array<{
    lockDir: string;
    pid: number;
    source: 'lock-dir-argument' | 'project-argument' | 'process-cwd' | 'listener-cwd';
  }>;
  unavailable: string[];
}

export function createProbeFailureReporter(): (pid: number) => ProcessProbeOptions {
  const warned = new Set<number>();
  return (pid) => ({
    onProbeFailure: (failure) => {
      if (warned.has(pid)) return;
      warned.add(pid);
      process.stderr.write(renderProbeFailure(failure));
    },
  });
}

export async function scanLockProcesses(
  probeOptions: (pid: number) => ProcessProbeOptions = createProbeFailureReporter(),
): Promise<LockProcessScan> {
  const scan: LockProcessScan = { candidates: [], unavailable: [] };
  let entries: OkProcessEntry[];
  try {
    entries = await findOkProcessEntries(true);
  } catch (error) {
    scan.unavailable.push(error instanceof Error ? error.message : String(error));
    return scan;
  }
  const add = async (
    lockDir: string,
    pid: number,
    source: LockProcessScan['candidates'][number]['source'],
  ) => {
    const canonical = await realpath(lockDir).catch(() => resolve(lockDir));
    scan.candidates.push({ lockDir: canonical, pid, source });
  };
  const addProject = async (
    project: string,
    pid: number,
    source: LockProcessScan['candidates'][number]['source'],
  ) => {
    await add(join(project, '.ok', 'local'), pid, source);
    await add(join(project, '.ok'), pid, source);
  };
  const pendingCwd: Array<{ pid: number; source: 'process-cwd' | 'listener-cwd' }> = [];
  for (const entry of entries) {
    if (!isValidLockPid(entry.pid)) continue;
    const marked = extractMarkedLockDir(entry.command);
    const project = extractProjectPathArg(entry.command);
    if (marked) await add(marked, entry.pid, 'lock-dir-argument');
    else if (project) await addProject(project, entry.pid, 'project-argument');
    else pendingCwd.push({ pid: entry.pid, source: 'process-cwd' });
  }
  let listeners: number[] = [];
  let listenerFailure = '';
  try {
    listeners = await readListeningPids(true);
  } catch (error) {
    listenerFailure = `Could not enumerate TCP listeners: lsof (${LISTENER_QUERY_ARGS.join(' ')}): ${describeListingError(error)}`;
  }
  const known = new Set(entries.map((entry) => entry.pid));
  for (const pid of listeners) {
    if (isValidLockPid(pid) && !known.has(pid)) pendingCwd.push({ pid, source: 'listener-cwd' });
  }
  const cwds = readPidCwds(pendingCwd.map(({ pid }) => pid));
  for (const { pid, source } of pendingCwd) {
    const cwd = cwds.get(pid);
    if (cwd) await addProject(cwd, pid, source);
    else if (isLockProcessRunning(pid, probeOptions(pid)))
      scan.unavailable.push(`Could not read the working directory of process ${pid}`);
  }
  if (listenerFailure) scan.unavailable.push(listenerFailure);
  const defunctCandidates = new Set<number>();
  for (const pid of new Set(scan.candidates.map((candidate) => candidate.pid))) {
    if (isDefunctProcess(pid, probeOptions(pid))) defunctCandidates.add(pid);
  }
  scan.candidates = scan.candidates.filter((candidate) => !defunctCandidates.has(candidate.pid));
  return scan;
}
