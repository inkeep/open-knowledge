import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type GhDetectResult =
  | { available: false }
  | {
      available: true;
      token: string;
      /**
       * The `gh` account that produced `token`. Undefined when the host's
       * active account produced it — `gh auth token` names no account, so the
       * only way to learn the active login is `detectGhAccounts`.
       */
      resolvedLogin?: string;
      /**
       * True when a requested account had no token and the active account
       * answered instead. Callers that surface an identity must read
       * `resolvedLogin`, not the login they asked for.
       */
      fallback?: boolean;
    };

export type ExecFileSyncFn = typeof execFileSync;
type FileExistsFn = (path: string) => boolean;

/**
 * Standard install locations for `gh` on macOS + Linux. Checked when the bare
 * `gh` lookup via `PATH` fails — which happens whenever OpenKnowledge runs
 * from a context that doesn't inherit the user's shell PATH. The macOS GUI
 * launch path (`launchd` → Electron → utility fork → spawned CLI) is the
 * load-bearing case: `launchd` provides only `/usr/bin:/bin:/usr/sbin:/sbin`,
 * so Homebrew-installed binaries at `/opt/homebrew/bin` are invisible.
 */
const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh', // macOS Apple Silicon Homebrew
  '/usr/local/bin/gh', // macOS Intel Homebrew / manual install
  '/opt/local/bin/gh', // macOS MacPorts
  '/snap/bin/gh', // Linux snap
  '/usr/bin/gh', // Linux distro packages
];

const GH_EXEC_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5000,
  windowsHide: true,
};

export interface DetectGhOptions {
  /**
   * Scope the lookup to one of several accounts signed in to the same host.
   * Carried on the options bag rather than as a positional parameter so the
   * signature grows additively: `detectGh` is re-exported from the published
   * package, and inserting a parameter ahead of this object would silently
   * reinterpret an existing two-argument call.
   */
  login?: string;
  /** Injectable for tests. */
  _exec?: ExecFileSyncFn;
  /** Injectable for tests. */
  _fileExists?: FileExistsFn;
}

/**
 * Detect whether `gh` CLI is on PATH (or a known absolute install path) and
 * currently authenticated. Returns the token from `gh auth token` on success.
 *
 * When `host` is provided, scopes the lookup with `--hostname <host>` so a
 * GHES-only login isn't mistaken for github.com auth (or vice versa). Note
 * the flag spelling — `gh auth token` rejects `--host` with "unknown flag";
 * the canonical name is `--hostname` (alias `-h`).
 *
 * When `options.login` is provided, scopes the lookup further with `--user <login>` to
 * pick one of several accounts signed in to the same host. A login that gh
 * cannot serve is never fatal: the lookup retries without `--user` and returns
 * the active account's token with `fallback: true`. Returning no credential
 * instead would turn a wrong-identity push into a failed one, and the same
 * retry covers gh versions predating `--user`, which reject the flag outright.
 *
 * Lookup order: bare `gh` via `PATH` first (fast path for shell launches),
 * then `KNOWN_GH_PATHS` in order (only paths that exist on disk are tried).
 * Stops at the first command that returns a non-empty token.
 */
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

/**
 * Runs one `gh` argv against each candidate path, stopping at the first that
 * answers. A candidate that is missing, exits non-zero, or prints nothing is
 * indistinguishable here on purpose: `gh` reports "no such account" the same
 * way it reports "not installed" — non-zero exit, empty stdout.
 */
function firstNonEmptyOutput(
  exec: ExecFileSyncFn,
  candidates: readonly string[],
  args: readonly string[],
): string | undefined {
  for (const cmd of candidates) {
    try {
      const out = exec(cmd, args, GH_EXEC_OPTIONS).toString().trim();
      if (out.length > 0) return out;
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

/** One `gh` account on a host, as reported by `gh auth status`. */
export interface GhAccount {
  login: string;
  active: boolean;
}

/**
 * List the `gh` accounts signed in to `host`, so a caller can name the identity
 * behind a token `gh auth token` returned anonymously.
 *
 * Three tiers, because the account list is diagnostic and must never take an
 * auth path down with it: the `--json` listing (gh 2.81+), then the
 * multi-account text listing (gh 2.40+ — older gh prints
 * `Logged in to <host> as <login>` with no active-account line and yields no
 * accounts here, the same release boundary as `--user` itself), then
 * `undefined` for "cannot tell".
 */
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

/**
 * `gh auth status --json hosts` emits `{hosts: {<host>: [{login, active, ...}]}}`.
 * That shape belongs to gh and moves on gh's release cadence, so anything that
 * does not match returns undefined and lets the caller drop a tier rather than
 * throw into a path whose real job is resolving a token.
 *
 * Structure is strict, fields are tolerant: a host whose value is not a list of
 * entries means we are reading a payload we do not understand, and reporting
 * "no accounts" for it would be a confident wrong answer where the text listing
 * still holds the right one. An individual entry missing a login is skipped, so
 * a future entry kind does not cost us the accounts alongside it.
 *
 * When `host` is given, only that host's entries are read — a payload that
 * omits the host yields `undefined` ("this payload doesn't describe that
 * host"), never another host's accounts and never a confident empty listing
 * that would suppress the text tier still holding the right answer. gh
 * already filters the payload by `--hostname` today, so this guards the
 * future case where a payload carries several hosts: a flattened fallback
 * would let a GHES account name itself as the identity behind a github.com
 * probe.
 */
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

/**
 * `gh auth status` prints one header line per account followed by that
 * account's detail lines, so an `- Active account: true` line qualifies the
 * header above it. A failed or timed-out account's header ("Failed to log in
 * to …" / "Timeout trying to log in to …") never becomes an account — but gh
 * still prints that account's detail lines, INCLUDING `- Active account:
 * true`, so the parser must drop its anchor at such a header or the broken
 * account's active flag lands on whichever healthy account came before it
 * (and the identity copy then confidently names the wrong person).
 */
const GH_LOGGED_IN_LINE = /Logged in to \S+ account (\S+) \(/;
const GH_FAILED_LOGIN_LINE = /(?:Failed to log in to|Timeout trying to log in to) \S+/;
const GH_ACTIVE_ACCOUNT_LINE = /^\s*-\s*Active account:\s*true\s*$/;

// gh bolds the login under forced color (CLICOLOR_FORCE / GH_FORCE_TTY), and
// `\S+` would capture the escape codes with it — the ANSI is stripped before
// matching so a forced-color environment doesn't corrupt every login this
// parser feeds into identity copy.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape byte is the point
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function parseGhAccountsText(raw: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  // The account the detail lines currently qualify — explicitly tracked (not
  // `accounts.at(-1)`) so a failed account's details attach to nothing
  // rather than to the last healthy account.
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
