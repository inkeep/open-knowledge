import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type GhDetectResult =
  | { available: false }
  | {
      available: true;
      token: string;
      resolvedLogin?: string;
      fallback?: boolean;
    };

export type ExecFileSyncFn = typeof execFileSync;
type FileExistsFn = (path: string) => boolean;

const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/opt/local/bin/gh',
  '/snap/bin/gh',
  '/usr/bin/gh',
];

const GH_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

export interface DetectGhOptions {
  login?: string;
  _exec?: ExecFileSyncFn;
  _fileExists?: FileExistsFn;
}

export function detectGh(host?: string, options: DetectGhOptions = {}): GhDetectResult {
  const { login } = options;
  const exec = options._exec ?? execFileSync;
  const candidates = ghCandidates(options._fileExists ?? existsSync);
  const hostArgs = host ? ['--hostname', host] : [];

  if (login) {
    const token = firstNonEmptyOutput(exec, candidates, [
      'auth',
      'token',
      ...hostArgs,
      '--user',
      login,
    ]);
    if (token) return { available: true, token, resolvedLogin: login, fallback: false };
  }

  const token = firstNonEmptyOutput(exec, candidates, ['auth', 'token', ...hostArgs]);
  if (!token) return { available: false };
  return login ? { available: true, token, fallback: true } : { available: true, token };
}

function ghCandidates(fileExists: FileExistsFn): string[] {
  return ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];
}

function firstNonEmptyOutput(
  exec: ExecFileSyncFn,
  candidates: readonly string[],
  args: readonly string[],
): string | undefined {
  for (const cmd of candidates) {
    try {
      const out = exec(cmd, args, GH_EXEC_OPTIONS).toString().trim();
      if (out.length > 0) return out;
    } catch {}
  }
  return undefined;
}

export interface GhAccount {
  login: string;
  active: boolean;
}

export function detectGhAccounts(
  host?: string,
  options: DetectGhOptions = {},
): GhAccount[] | undefined {
  const exec = options._exec ?? execFileSync;
  const candidates = ghCandidates(options._fileExists ?? existsSync);
  const statusArgs = ['auth', 'status', ...(host ? ['--hostname', host] : [])];

  const json = firstNonEmptyOutput(exec, candidates, [...statusArgs, '--json', 'hosts']);
  if (json !== undefined) {
    const accounts = parseGhAccountsJson(json, host);
    if (accounts) return accounts;
  }

  const text = firstNonEmptyOutput(exec, candidates, statusArgs);
  if (text !== undefined) {
    const accounts = parseGhAccountsText(text);
    if (accounts.length > 0) return accounts;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseGhAccountsJson(raw: string, host?: string): GhAccount[] | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const hosts = asRecord(asRecord(payload)?.hosts);
  if (!hosts) return undefined;

  if (host !== undefined && hosts[host] === undefined) return undefined;
  const entryLists = host !== undefined ? [hosts[host]] : Object.values(hosts);

  const accounts: GhAccount[] = [];
  for (const entries of entryLists) {
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      const record = asRecord(entry);
      if (!record) continue;
      const login = record.login;
      if (typeof login !== 'string' || login.length === 0) continue;
      accounts.push({ login, active: record.active === true });
    }
  }
  return accounts;
}

const GH_LOGGED_IN_LINE = /Logged in to \S+ account (\S+) \(/;
const GH_FAILED_LOGIN_LINE = /(?:Failed to log in to|Timeout trying to log in to) \S+/;
const GH_ACTIVE_ACCOUNT_LINE = /^\s*-\s*Active account:\s*true\s*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape byte is the point
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function parseGhAccountsText(raw: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  let anchor: GhAccount | undefined;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(ANSI_SGR, '');
    const login = GH_LOGGED_IN_LINE.exec(line)?.[1];
    if (login) {
      anchor = { login, active: false };
      accounts.push(anchor);
      continue;
    }
    if (GH_FAILED_LOGIN_LINE.test(line)) {
      anchor = undefined;
      continue;
    }
    if (anchor && GH_ACTIVE_ACCOUNT_LINE.test(line)) anchor.active = true;
  }
  return accounts;
}
