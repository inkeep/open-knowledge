/**
 * Pure helpers for the three Publish-to-GitHub wizard endpoints:
 *
 *   GET  /api/share/publish/owners        — list user + orgs eligible to host
 *   GET  /api/share/publish/name-check    — pre-flight a repo name for conflict
 *   POST /api/share/publish               — git init + create repo + push
 *
 * Each handler spawns the `open-knowledge share <sub>` CLI subprocess
 * (mirroring `handleLocalOpAuthStatus` / `handleLocalOpAuthRepos`) and
 * parses one JSON event line from stdout. This file owns the parsing and
 * code-mapping logic; the orchestrator (spawning + lifetime) is inlined in
 * `api-extension.ts` so the route-table meta-tests can discover the
 * handler shape.
 *
 * The 1-line NDJSON output convention matches the CLI's `--json` flag and
 * keeps the server-side wire contract a single `successResponse(...)` call
 * per request (no streaming).
 */

import type {
  SharePublishErrorCode,
  SharePublishNameCheckResponse,
  SharePublishOwner,
  SharePublishOwnersErrorCode,
  SharePublishOwnersResponse,
  SharePublishResponse,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

// ─── Handler tags + URL keys ─────────────────────────────────────────────────

export const SHARE_PUBLISH_OWNERS_HANDLER_TAG = 'share-publish-owners';
export const SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG = 'share-publish-name-check';
export const SHARE_PUBLISH_HANDLER_TAG = 'share-publish';

export const SHARE_PUBLISH_OWNERS_KEY = '/api/share/publish/owners';
export const SHARE_PUBLISH_NAME_CHECK_KEY = '/api/share/publish/name-check';
export const SHARE_PUBLISH_KEY = '/api/share/publish';

/**
 * Bound subprocess lifetime to 30s — owners and name-check are quick GitHub
 * GETs; publish does up to `git init` + repo-create + initial push. Real
 * publishes against a small project finish well inside this window; a hung
 * subprocess should never gum up the editor's UI for more than 30s.
 */
export const SHARE_PUBLISH_TIMEOUT_MS = 30_000;

// ─── Name validation (server-side re-check) ──────────────────────────────────

/**
 * GitHub's repo name rules (`[A-Za-z0-9._-]`, ≤100 chars, no leading dot,
 * not all dashes). We re-validate server-side so a malformed name from a
 * pre-wizard caller doesn't reach the CLI subprocess.
 */
export function isValidShareRepoName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (name.startsWith('.') || name.startsWith('-')) return false;
  if (/^-+$/.test(name)) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * GitHub owner names follow the same character class as repo names but
 * top out at 39 chars. Re-validated server-side as defense-in-depth.
 */
export function isValidShareOwnerName(owner: string): boolean {
  if (owner.length === 0 || owner.length > 39) return false;
  if (owner.startsWith('-') || owner.endsWith('-')) return false;
  return /^[A-Za-z0-9-]+$/.test(owner);
}

// ─── Subprocess event parsing ────────────────────────────────────────────────

/**
 * Pick the last parseable JSON line from a CLI subprocess's stdout. The
 * CLI may emit non-JSON log lines on stdout before the terminal event
 * (e.g. keychain probe on older builds); the canonical event is always
 * the last JSON line per the share CLI commands' contract.
 */
export function pickTerminalJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i] as string);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* skip non-JSON line */
    }
  }
  return null;
}

// ─── Owners — CLI event → response body ──────────────────────────────────────

/**
 * Map the CLI's `share owners --json` terminal event onto the wire
 * response body. The CLI emits one of:
 *   { type: 'owners', owners: [...] }
 *   { type: 'error', code: 'auth-required' | 'network' }
 *
 * Unrecognized or malformed events surface as `network` — the wire body
 * stays in the closed enum no matter what the subprocess returns.
 */
export function parseOwnersEvent(
  event: Record<string, unknown> | null,
): SharePublishOwnersResponse {
  if (event === null) {
    return { ok: false, error: 'network' };
  }
  if (event.type === 'owners' && Array.isArray(event.owners)) {
    const owners: SharePublishOwner[] = [];
    for (const raw of event.owners) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const login = typeof o.login === 'string' ? o.login : null;
      const kind = o.kind === 'user' || o.kind === 'org' ? o.kind : null;
      if (login === null || kind === null) continue;
      const avatarUrl = typeof o.avatarUrl === 'string' ? o.avatarUrl : undefined;
      owners.push({ login, kind, ...(avatarUrl ? { avatarUrl } : {}) });
    }
    return { ok: true, owners };
  }
  if (event.type === 'error') {
    const code = isOwnersErrorCode(event.code) ? event.code : 'network';
    return { ok: false, error: code };
  }
  return { ok: false, error: 'network' };
}

function isOwnersErrorCode(value: unknown): value is SharePublishOwnersErrorCode {
  return value === 'auth-required' || value === 'network';
}

// ─── Name-check — CLI event → response body ──────────────────────────────────

/**
 * Map the CLI's `share name-check --json` terminal event onto the wire
 * response body. The CLI emits one of:
 *   { type: 'name-check', available: boolean }
 *   { type: 'error', code: 'auth-required' | 'network' }
 */
export function parseNameCheckEvent(
  event: Record<string, unknown> | null,
): SharePublishNameCheckResponse {
  if (event === null) return { ok: false, error: 'network' };
  if (event.type === 'name-check' && typeof event.available === 'boolean') {
    return { ok: true, available: event.available };
  }
  if (event.type === 'error') {
    const code = isOwnersErrorCode(event.code) ? event.code : 'network';
    return { ok: false, error: code };
  }
  return { ok: false, error: 'network' };
}

// ─── Publish — CLI event → response body ─────────────────────────────────────

const PUBLISH_ERROR_CODES: ReadonlySet<SharePublishErrorCode> = new Set([
  'name-conflict',
  'saml-sso',
  'auth-required',
  'push-failed',
  'init-failed',
  'network',
  'no-project',
]);

function isPublishErrorCode(value: unknown): value is SharePublishErrorCode {
  return typeof value === 'string' && PUBLISH_ERROR_CODES.has(value as SharePublishErrorCode);
}

/**
 * Map the CLI's `share publish --json` terminal event onto the wire
 * response body. The CLI emits one of:
 *   { type: 'publish', ownerLogin, repoName, cloneUrl, defaultBranch }
 *   { type: 'error', code: <PublishErrorCode> }
 */
export function parsePublishEvent(event: Record<string, unknown> | null): SharePublishResponse {
  if (event === null) return { ok: false, error: 'network' };
  if (event.type === 'publish') {
    const ownerLogin = typeof event.ownerLogin === 'string' ? event.ownerLogin : null;
    const repoName = typeof event.repoName === 'string' ? event.repoName : null;
    const cloneUrl = typeof event.cloneUrl === 'string' ? event.cloneUrl : null;
    const defaultBranch = typeof event.defaultBranch === 'string' ? event.defaultBranch : null;
    if (ownerLogin !== null && repoName !== null && cloneUrl !== null && defaultBranch !== null) {
      return { ok: true, ownerLogin, repoName, cloneUrl, defaultBranch };
    }
    // The CLI promised the field but didn't deliver — treat as transport
    // class so the wire body stays in-schema.
    return { ok: false, error: 'network' };
  }
  if (event.type === 'error') {
    const code = isPublishErrorCode(event.code) ? event.code : 'network';
    return { ok: false, error: code };
  }
  return { ok: false, error: 'network' };
}

// ─── Structured logs (pino, non-PII) ─────────────────────────────────────────

/**
 * Structured ops logging for the share-publish flow; non-PII (no project
 * path, no owner, no repo name, no URL). All three publish endpoints emit
 * through here so the log shape stays single-source.
 */
export function emitSharePublishLog(
  action: 'owners-list' | 'name-check' | 'publish-create',
  result: 'ok' | string,
  extras?: { count?: number; available?: boolean },
): void {
  getLogger('share').info(
    {
      action,
      result,
      ...(extras?.count !== undefined ? { count: extras.count } : {}),
      ...(extras?.available !== undefined ? { available: extras.available } : {}),
    },
    'share action',
  );
}

/**
 * Strip credentials embedded in URLs of the form
 * `https://x-access-token:<pat>@github.com/...` (the inline-token push URL
 * used by `share publish`). Replaces the token with
 * `***` so a partial git stderr message in a logged subprocess failure
 * doesn't leak the PAT. Also handles the bare `<user>:<pwd>@host` form for
 * completeness.
 */
export function redactShareSubprocessStderr(stderr: string): string {
  return stderr.replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/g, '$1$2:***@');
}
