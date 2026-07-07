/**
 * Process-scan discovery utility for `ok ps`.
 *
 * Finds all running open-knowledge server lock dirs by:
 *   1. Enumerating candidate PIDs via pgrep (falls back to ps)
 *   2. Resolving each PID's CWD via lsof
 *   3. Checking whether <cwd>/.ok/local or legacy lock dirs exist
 *   4. Supplementing with a listening-port scan via lsof -iTCP
 *   5. Deduplicating by canonical (realpath) path
 *
 * All subprocess calls have a 2-second timeout. Unavailable tools degrade
 * gracefully — never throw.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

const SPAWN_TIMEOUT_MS = 2000;
const LOCK_SCAN_MAX_DEPTH = 3;
const LOCK_SCAN_MAX_ENTRIES = 2000;
const OK_LOCK_DIR_ARG_PREFIX = '--ok-lock-dir-b64=';
const OK_PROJECT_PATH_ARG_PREFIX = '--ok-project-path=';
const OK_PROCESS_PGREP_QUERY =
  'cli\\.mjs|open-knowledge|Open ?Knowledge(\\.app| Helper)|--ok-lock-dir-b64=|--ok-project-path=|(^|[ /])ok[ ]+(start|mcp|ui)([ ]|$)|packages/(cli|app)|hocuspocus|vite';

/**
 * Patterns that identify an open-knowledge process in a command string.
 * Mirrors the `filter_process_lines` patterns in diagnose-server-processes.sh.
 */
const OK_PROCESS_PATTERNS: RegExp[] = [
  // The compiled CLI entry point
  /cli\.mjs/,
  // Installed bin commands with subcommands
  /(^|[\s/])(open-knowledge|ok)\s+(start|mcp|ui)(\s|$)/,
  // Packaged Electron desktop helpers. Older builds did not include the
  // explicit lock-dir marker, but their argv still identifies the OK helper.
  // The optional space matches both the legacy "Open Knowledge" bundle and the
  // renamed "OpenKnowledge" bundle, so `ok ps`/`ok stop` keep finding processes
  // from a still-running pre-rename build.
  /Open ?Knowledge(?:\.app| Helper)/,
  // Bun dev-server patterns
  /(^|[\s/])bun([\s/]).*?(run dev|packages\/app|vite|hocuspocus)/,
  // Node dev-server patterns
  /(^|[\s/])node([\s/]).*?(packages\/(cli|app)|vite|hocuspocus)/,
  // Electron utility marker: main passes the project lock dir explicitly so
  // global discovery does not depend on the utility process cwd.
  /(^|\s)--ok-lock-dir-b64=/,
  // Renderer argv carries the project path even when the Node utility argv
  // lacks the explicit lock-dir marker in packaged builds.
  /(^|\s)--ok-project-path=/,
];

/**
 * Returns true if the given command string looks like an open-knowledge process.
 */
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
    // Buffer.from('base64url') silently drops invalid bytes and never throws;
    // isAbsolute above is the real guard. Catch kept as defensive fallback.
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

/**
 * Parse `pgrep -a -f` output: lines of "<pid> <command>".
 */
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

/**
 * Parse `ps -axo pid,command` output: first token is PID, rest is command.
 */
function parsePsOutput(output: string): OkProcessEntry[] {
  const entries: OkProcessEntry[] = [];
  const lines = output.split('\n');
  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const pidStr = line.slice(0, spaceIdx);
    const command = line.slice(spaceIdx + 1).trim();
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isOkProcess(command)) {
      entries.push({ pid, command });
    }
  }
  return entries;
}

/**
 * Find open-knowledge processes, returning both PID and command string.
 *
 * Tries `pgrep -a -f` first — it reads kernel argv directly and is not subject
 * to the column-width truncation that `ps -p PID -o command=` has on macOS BSD.
 * Falls back to `ps -axo pid,command` when pgrep is unavailable (ENOENT) or
 * when the platform's pgrep prints PID-only lines despite `-a`.
 * pgrep exit code 1 means "no matches" — that is NOT a fallback trigger.
 */
async function findOkProcessEntries(): Promise<OkProcessEntry[]> {
  const pgrepResult = spawnSync('pgrep', ['-a', '-f', OK_PROCESS_PGREP_QUERY], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  const pgrepUnavailable =
    pgrepResult.error != null && (pgrepResult.error as NodeJS.ErrnoException).code === 'ENOENT';

  if (!pgrepUnavailable) {
    // pgrep ran (may have exit code 1 if no matches — that's fine)
    const output = pgrepResult.stdout ?? '';
    const entries = parsePgrepOutput(output);
    if (entries.length > 0 || output.trim() === '') return entries;
    // macOS/BSD pgrep accepts `-a` but still prints PID-only lines; use ps so
    // the command matcher can inspect full argv instead of dropping matches.
  }

  // pgrep not available or returned PID-only lines — fall back to ps
  const psResult = spawnSync('ps', ['-axo', 'pid,command'], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (psResult.error != null || !psResult.stdout) {
    return [];
  }

  return parsePsOutput(psResult.stdout);
}

/**
 * Find PIDs of open-knowledge processes.
 */
export async function findOkProcessPids(): Promise<number[]> {
  return (await findOkProcessEntries()).map((e) => e.pid);
}

/**
 * Resolve the working directory of a process via `lsof -p <pid> -a -d cwd -Fn`.
 *
 * Returns null (never throws) when:
 *   - lsof is unavailable (ENOENT)
 *   - the process has no readable CWD (e.g., exited between scan and lookup)
 *   - the spawn times out
 */
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
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error != null || !result.stdout) return null;
  return result.stdout.trim() || null;
}

export interface ProcessUsage {
  cpuPercent: number;
  memPercent: number;
}

export function processUsage(pid: number): ProcessUsage | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', '%cpu=,%mem='], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error != null || !result.stdout) return null;
  const [cpuRaw, memRaw] = result.stdout.trim().split(/\s+/);
  const cpuPercent = Number.parseFloat(cpuRaw ?? '');
  const memPercent = Number.parseFloat(memRaw ?? '');
  if (Number.isNaN(cpuPercent) || Number.isNaN(memPercent)) return null;
  return { cpuPercent, memPercent };
}

export async function pidCwd(pid: number): Promise<string | null> {
  const result = spawnSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (result.error != null) {
    // ENOENT = lsof unavailable; ETIMEDOUT / killed by timeout signal
    return null;
  }

  const output = result.stdout ?? '';
  // lsof -Fn output lines starting with 'n' carry the name (path)
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) {
      return line.slice(1);
    }
  }

  return null;
}

/**
 * Parse PIDs from `lsof -iTCP -sTCP:LISTEN -nP` output.
 * Each data line has format: COMMAND PID USER ...
 */
function parseListeningPids(output: string): number[] {
  const pids: number[] = [];
  const lines = output.split('\n');
  // Skip header line (starts with "COMMAND")
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isNaN(pid)) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/**
 * Full discovery pipeline: finds all `.ok/local/` lock dirs for running
 * open-knowledge servers.
 *
 * Returns unique canonical directory paths (each is the lock dir,
 * i.e. `<contentDir>/.ok/local`).
 */
function hasLockFile(lockDir: string): boolean {
  return existsSync(join(lockDir, 'server.lock')) || existsSync(join(lockDir, 'ui.lock'));
}

function addLockDirsForCwd(candidateDirs: Set<string>, cwd: string): void {
  for (const lockDir of [join(cwd, '.ok', 'local'), join(cwd, '.ok')]) {
    if (existsSync(lockDir) && hasLockFile(lockDir)) {
      candidateDirs.add(lockDir);
    }
  }
}

/**
 * Bounded cwd-subtree fallback for desktop helpers whose cwd is `/` and whose
 * argv lacks `--ok-lock-dir-b64`. This catches the common navigator case:
 * running `ok ps` from a collection folder that contains many OK projects.
 */
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

  // Step 1+2: process scan → explicit Electron marker / CWD → lock-dir check
  // Command strings come from pgrep -a -f (reads kernel argv, not truncated).
  const okEntries = await findOkProcessEntries();
  const cwdPromises = okEntries.map((e) => pidCwd(e.pid));
  const cwds = await Promise.all(cwdPromises);

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

  // Step 3: supplementary port scan — catches PIDs missed by process matching
  const lsofResult = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP'], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (lsofResult.error == null && lsofResult.stdout) {
    const listeningPids = parseListeningPids(lsofResult.stdout);
    // Resolve CWDs for all listening PIDs not already in our set
    const knownPidSet = new Set(okEntries.map((e) => e.pid));
    const newPids = listeningPids.filter((p) => !knownPidSet.has(p));
    const portCwdPromises = newPids.map((pid) => pidCwd(pid));
    const portCwds = await Promise.all(portCwdPromises);

    for (const cwd of portCwds) {
      if (cwd == null) continue;
      addLockDirsForCwd(candidateDirs, cwd);
    }
  }

  // Step 4: bounded cwd-subtree scan. This is intentionally last and capped:
  // process metadata is authoritative when present, while this fallback exists
  // for older desktop utility processes whose cwd is `/` and argv lacks the
  // explicit lock-dir marker. Running from a parent folder should still find
  // child OK projects with live locks.
  if (candidateDirs.size === 0 || cwds.some((cwd) => cwd === '/')) {
    addLockDirsUnderCwd(candidateDirs, process.cwd());
  }

  // Dedup by canonical path (resolve symlinks)
  const canonical = new Map<string, string>();
  for (const dir of candidateDirs) {
    try {
      const real = await realpath(dir);
      canonical.set(real, real);
    } catch {
      // If realpath fails, use the unresolved path
      canonical.set(dir, dir);
    }
  }

  return [...canonical.values()];
}
