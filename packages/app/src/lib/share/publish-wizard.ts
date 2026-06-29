
import type {
  SharePublishErrorCode,
  SharePublishNameCheckResponse,
  SharePublishOwner,
  SharePublishOwnersResponse,
  SharePublishRequest,
  SharePublishResponse,
  SharePublishVisibility,
} from '@inkeep/open-knowledge-core';
import {
  SharePublishNameCheckResponseSchema,
  SharePublishOwnersResponseSchema,
  SharePublishResponseSchema,
} from '@inkeep/open-knowledge-core';

const SHARE_PUBLISH_OWNERS_PATH = '/api/share/publish/owners';
const SHARE_PUBLISH_NAME_CHECK_PATH = '/api/share/publish/name-check';
const SHARE_PUBLISH_PATH = '/api/share/publish';

const REPO_NAME_ALLOWED = /[A-Za-z0-9._-]/g;

export function sanitizeRepoName(input: string): string {
  const kept = input.match(REPO_NAME_ALLOWED)?.join('') ?? '';
  const collapsed = kept.replace(/[-.]{2,}/g, (match) => match[0] ?? '-');
  return collapsed.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
}

export { extractFolderBasename } from '@/lib/path-utils';

export function pickDefaultOwner(owners: SharePublishOwner[]): string {
  const firstOrg = owners.find((o) => o.kind === 'org');
  return firstOrg?.login ?? owners[0]?.login ?? '';
}

export function buildSamlSsoAuthorizeUrl(orgLogin: string): string {
  return `https://github.com/orgs/${encodeURIComponent(orgLogin)}/policies/applications`;
}

export interface PublishErrorPresentation {
  banner: string;
  next:
    | { kind: 'edit-name' }
    | { kind: 'authorize-org'; authorizeUrl: string }
    | { kind: 'retry-push' }
    | { kind: 'reauth' }
    | { kind: 'edit-form' };
}

export function presentPublishError(
  error: SharePublishErrorCode,
  owner: string,
  name: string,
): PublishErrorPresentation {
  switch (error) {
    case 'name-conflict':
      return {
        banner: `${owner}/${name} already exists. Pick a different name.`,
        next: { kind: 'edit-name' },
      };
    case 'saml-sso':
      return {
        banner: `GitHub denied the request. You may need to authorize OpenKnowledge for ${owner} in your browser.`,
        next: { kind: 'authorize-org', authorizeUrl: buildSamlSsoAuthorizeUrl(owner) },
      };
    case 'push-failed':
      return {
        banner: `Created ${owner}/${name}, push failed.`,
        next: { kind: 'retry-push' },
      };
    case 'auth-required':
      return {
        banner: 'GitHub connection expired. Connect again to continue.',
        next: { kind: 'reauth' },
      };
    case 'init-failed':
      return {
        banner: "Couldn't prepare this project for publish.",
        next: { kind: 'edit-form' },
      };
    case 'network':
      return {
        banner: "Couldn't reach GitHub. Try again?",
        next: { kind: 'edit-form' },
      };
    case 'no-project':
      return {
        banner: 'Open a project first.',
        next: { kind: 'edit-form' },
      };
  }
}


export async function fetchPublishOwners(
  fetchFn: typeof fetch = fetch,
): Promise<SharePublishOwnersResponse> {
  const res = await fetchFn(SHARE_PUBLISH_OWNERS_PATH, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`owners transport ${res.status}`);
  }
  const body = await res.json();
  const parsed = SharePublishOwnersResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('owners response shape mismatch');
  }
  return parsed.data;
}

export async function fetchPublishNameCheck(
  owner: string,
  name: string,
  fetchFn: typeof fetch = fetch,
): Promise<SharePublishNameCheckResponse> {
  const url = `${SHARE_PUBLISH_NAME_CHECK_PATH}?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`;
  const res = await fetchFn(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`name-check transport ${res.status}`);
  }
  const body = await res.json();
  const parsed = SharePublishNameCheckResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('name-check response shape mismatch');
  }
  return parsed.data;
}

export async function submitPublishRequest(
  request: SharePublishRequest,
  fetchFn: typeof fetch = fetch,
): Promise<SharePublishResponse> {
  const res = await fetchFn(SHARE_PUBLISH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`publish transport ${res.status}`);
  }
  const body = await res.json();
  const parsed = SharePublishResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('publish response shape mismatch');
  }
  return parsed.data;
}


export type NameCheckStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken'; owner: string; name: string }
  | { kind: 'error'; banner: string };

export function resolveNameCheckStatus(
  response: SharePublishNameCheckResponse,
  owner: string,
  name: string,
): NameCheckStatus {
  if (response.ok) {
    return response.available ? { kind: 'available' } : { kind: 'taken', owner, name };
  }
  if (response.error === 'auth-required') {
    return { kind: 'error', banner: 'GitHub connection expired. Connect again to continue.' };
  }
  return { kind: 'error', banner: "Couldn't reach GitHub. Try again?" };
}

export function canSubmitPublish(input: {
  owner: SharePublishOwner | null;
  sanitizedName: string;
  nameCheck: NameCheckStatus;
  submitting: boolean;
}): boolean {
  if (input.submitting) return false;
  if (input.owner === null) return false;
  if (input.sanitizedName.length === 0) return false;
  return input.nameCheck.kind === 'available';
}


export type { SharePublishOwner, SharePublishRequest, SharePublishVisibility };
