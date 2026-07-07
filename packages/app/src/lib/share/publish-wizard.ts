/**
 * Pure orchestration + validation helpers for the Publish-to-GitHub wizard
 * (PublishToGitHubDialog). Every side effect — fetch, clipboard, toast,
 * `shell.openExternal`, the post-publish call to `runShareAction` — is
 * injected so the wizard's decision tree is unit-testable without React.
 *
 * Wire contract: matches `Share*` schemas in @inkeep/open-knowledge-core.
 * Endpoints: GET /api/share/publish/owners,
 * GET /api/share/publish/name-check, POST /api/share/publish.
 */

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

/**
 * GitHub's documented allowed character set for repository names. We match
 * the server-side regex in `SharePublishRequestSchema`'s downstream
 * validator (`packages/server/src/share/publish.ts` `isValidShareRepoName`)
 * so the wizard never POSTs a name the server will bounce. Empty string
 * yields an empty result so the consumer can show the "enter a name" hint.
 */
const REPO_NAME_ALLOWED = /[A-Za-z0-9._-]/g;

/**
 * Sanitize a candidate repo name in the shape the GitHub API + our
 * server-side validator both accept: keep `[A-Za-z0-9._-]`, drop everything
 * else, collapse repeated hyphens, trim leading/trailing dots and hyphens.
 *
 * The wizard seeds this from the project folder basename and lets the user
 * edit it; the result is what the "Will be created as `<name>`" preview
 * shows. The server re-validates (defense in depth) but the wizard is the
 * UX-visible enforcement point.
 */
export function sanitizeRepoName(input: string): string {
  const kept = input.match(REPO_NAME_ALLOWED)?.join('') ?? '';
  // Collapse runs of `-` / `.` and trim them at the edges so we never
  // produce a name starting or ending with a separator (GitHub rejects
  // `.foo`, `foo.`, `-foo`, `foo-`).
  const collapsed = kept.replace(/[-.]{2,}/g, (match) => match[0] ?? '-');
  return collapsed.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
}

export { extractFolderBasename } from '@/lib/path-utils';

/**
 * Pick the owner the wizard pre-selects when the owners list loads. We
 * prefer the first organization the user can publish into over their
 * personal account: when someone belongs to an org, a knowledge base is
 * far more likely meant for the team than for their own login, and
 * accidentally publishing it under the personal account is annoying to
 * undo (delete + re-publish + re-share). Falls back to the first entry
 * (the authenticated user, always returned first by the owners endpoint)
 * when there is no org, and to `''` for an empty list.
 */
export function pickDefaultOwner(owners: SharePublishOwner[]): string {
  const firstOrg = owners.find((o) => o.kind === 'org');
  return firstOrg?.login ?? owners[0]?.login ?? '';
}

/**
 * GitHub's "Authorize OpenKnowledge for <org>" surface. The Publish wizard
 * surfaces this on the SAML SSO 403 branch (generic SAML SSO branch) — receivers
 * click out into the system browser, complete the org authorization, then
 * retry the publish.
 */
export function buildSamlSsoAuthorizeUrl(orgLogin: string): string {
  // `encodeURIComponent` so a malformed login can never escape the
  // path-segment context. GitHub's actual policy page tolerates any
  // owner that is_alphanumeric_+_dash, but we don't want to assume.
  return `https://github.com/orgs/${encodeURIComponent(orgLogin)}/policies/applications`;
}

/**
 * The wizard's banner copy for each terminal publish error. Returns the
 * banner string AND a structured hint for the focus / next-action layer:
 *
 *   - `name-conflict` → focus the Name field, re-arm name-check
 *   - `saml-sso`      → show "Authorize in browser" button (org login parsed from owner)
 *   - `push-failed`   → show "Retry push" button (replays publish step but
 *                       NOT the create step — repo already exists)
 *   - `auth-required` → bounce through Device Flow modal then retry
 *   - default         → generic banner, stay on the form
 *
 * Bumping any of these strings should travel with the wizard's e2e —
 * they are part of the user contract.
 */
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

// ── Wire helpers ─────────────────────────────────────────────────────────────

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

// ── Name-check status ────────────────────────────────────────────────────────

/**
 * Status surfaced next to the Name field as the user types. `pending` is
 * the debounce window before fetch fires; `checking` is the in-flight
 * fetch; `available`/`taken` are the two ok branches; `error` is anything
 * we can't classify (auth-required, network).
 */
export type NameCheckStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken'; owner: string; name: string }
  | { kind: 'error'; banner: string };

/**
 * Map a name-check response (success/failure) plus the owner+name being
 * queried into the status the wizard renders. Pure — no side effects.
 */
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

/**
 * Submit is enabled iff: owner selected, name sanitized non-empty, the
 * latest name-check returned `available`, and we are not mid-submit.
 */
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

// ── Re-exports for the consumer ──────────────────────────────────────────────

export type { SharePublishOwner, SharePublishRequest, SharePublishVisibility };
