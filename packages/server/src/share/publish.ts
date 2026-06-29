import type {
  SharePublishErrorCode,
  SharePublishNameCheckResponse,
  SharePublishOwner,
  SharePublishOwnersErrorCode,
  SharePublishOwnersResponse,
  SharePublishResponse,
} from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

export const SHARE_PUBLISH_OWNERS_HANDLER_TAG = 'share-publish-owners';
export const SHARE_PUBLISH_NAME_CHECK_HANDLER_TAG = 'share-publish-name-check';
export const SHARE_PUBLISH_HANDLER_TAG = 'share-publish';

export const SHARE_PUBLISH_OWNERS_KEY = '/api/share/publish/owners';
export const SHARE_PUBLISH_NAME_CHECK_KEY = '/api/share/publish/name-check';
export const SHARE_PUBLISH_KEY = '/api/share/publish';

export const SHARE_PUBLISH_TIMEOUT_MS = 30_000;

export function isValidShareRepoName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (name.startsWith('.') || name.startsWith('-')) return false;
  if (/^-+$/.test(name)) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export function isValidShareOwnerName(owner: string): boolean {
  if (owner.length === 0 || owner.length > 39) return false;
  if (owner.startsWith('-') || owner.endsWith('-')) return false;
  return /^[A-Za-z0-9-]+$/.test(owner);
}

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
    } catch {}
  }
  return null;
}

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
    return { ok: false, error: 'network' };
  }
  if (event.type === 'error') {
    const code = isPublishErrorCode(event.code) ? event.code : 'network';
    return { ok: false, error: code };
  }
  return { ok: false, error: 'network' };
}

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

export function redactShareSubprocessStderr(stderr: string): string {
  return stderr.replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/g, '$1$2:***@');
}
