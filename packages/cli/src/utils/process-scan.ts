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

const OK_PROCESS_PATTERNS: RegExp[] = [
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

function parsePsOutput(output: string): OkProcessEntry[] {
  const entries: OkProcessEntry[] = [];
  const lines = output.split('\n');
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

async function findOkProcessEntries(): Promise<OkProcessEntry[]> {
  const pgrepResult = spawnSync('pgrep', ['-a', '-f', OK_PROCESS_PGREP_QUERY], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  const pgrepUnavailable =
    pgrepResult.error != null && (pgrepResult.error as NodeJS.ErrnoException).code === 'ENOENT';

  if (!pgrepUnavailable) {
    const output = pgrepResult.stdout ?? '';
    const entries = parsePgrepOutput(output);
    if (entries.length > 0 || output.trim() === '') return entries;
  }

  const psResult = spawnSync('ps', ['-axo', 'pid,command'], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (psResult.error != null || !psResult.stdout) {
    return [];
  }

  return parsePsOutput(psResult.stdout);
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
    return null;
  }

  const output = result.stdout ?? '';
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) {
      return line.slice(1);
    }
  }

  return null;
}

function parseListeningPids(output: string): number[] {
  const pids: number[] = [];
  const lines = output.split('\n');
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

  const lsofResult = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP'], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });

  if (lsofResult.error == null && lsofResult.stdout) {
    const listeningPids = parseListeningPids(lsofResult.stdout);
    const knownPidSet = new Set(okEntries.map((e) => e.pid));
    const newPids = listeningPids.filter((p) => !knownPidSet.has(p));
    const portCwdPromises = newPids.map((pid) => pidCwd(pid));
    const portCwds = await Promise.all(portCwdPromises);

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
