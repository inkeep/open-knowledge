import type {
  ShareConstructUrlErrorCode,
  ShareConstructUrlRequest,
  ShareConstructUrlResponse,
  ShareFreshness,
} from '@inkeep/open-knowledge-core';
import { ShareConstructUrlResponseSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { docNameToMarkdownPath } from '@/lib/doc-paths';

const SHARE_CONSTRUCT_URL_PATH = '/api/share/construct-url';

/**
 * Discriminated share target the button dispatches. `doc` carries the
 * document identifier (transformed to a `.md` / `.mdx` content-relative
 * `docPath` here, mirroring the editor's `docNameToMarkdownPath` convention);
 * `folder` carries the content-relative `folderRelativePath` verbatim (it is
 * already the wire's `folderPath` — the empty string is the content-root
 * sentinel, see `ShareConstructUrlRequestSchema`). Surfaces own construction
 * via `buildDocShareInput` / `buildFolderShareInput`; a `null` input disables
 * the trigger (nothing to share), mirroring `OpenInAgentMenu.input`.
 */
export type ShareTargetInput =
  | { kind: 'doc'; docName: string }
  | { kind: 'folder'; folderRelativePath: string };

/** File-scope share input from a document identifier. */
export function buildDocShareInput(docName: string): ShareTargetInput {
  return { kind: 'doc', docName };
}

/** Folder-scope share input from a content-relative folder path. */
export function buildFolderShareInput(folderRelativePath: string): ShareTargetInput {
  return { kind: 'folder', folderRelativePath };
}

/**
 * Which failure produced an error toast. Callers that surface one of these
 * another way suppress it by reason rather than by comparing the message —
 * a translated message is not a stable identity.
 */
export type ShareErrorToastReason = 'transport' | 'clipboard' | 'business';

export interface ShareActionDeps {
  fetchFn?: typeof fetch;
  /**
   * Called with the resolved share URL once the construct-url fetch
   * returns. Production callers route through `scheduleClipboardWrite`
   * (`clipboard-adapter.ts`) so the write prefers the Electron IPC bridge
   * when available and falls back to `navigator.clipboard.writeText`
   * otherwise. The caller MUST invoke `runShareAction` from inside a
   * fresh user-gesture handler — the browser fallback gates on transient
   * user activation at write time.
   */
  clipboardWrite: (text: string) => Promise<void>;
  toastSuccess: (msg: string) => void;
  toastError: (msg: string, reason: ShareErrorToastReason) => void;
  logEvent: (msg: string) => void;
}

export type RunShareActionInput = {
  hasRemote: boolean;
  onClickWhenNoRemote: () => void;
} & ShareTargetInput;

export type RunShareActionResult =
  | { kind: 'opened-wizard' }
  | { kind: 'copied'; shareUrl: string; branch: string; freshness?: ShareFreshness }
  | { kind: 'clipboard-failed'; shareUrl: string; freshness?: ShareFreshness }
  | { kind: 'business-error'; error: ShareConstructUrlErrorCode; branch?: string }
  | { kind: 'transport-error' };

export async function requestShareConstructUrl(
  body: ShareConstructUrlRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ShareConstructUrlResponse> {
  const res = await fetchFn(SHARE_CONSTRUCT_URL_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`construct-url transport ${res.status}`);
  }
  const responseBody = await res.json();
  const parsed = ShareConstructUrlResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error('construct-url response shape mismatch');
  }
  return parsed.data;
}

export function mapShareErrorToToast(error: ShareConstructUrlErrorCode, branch?: string): string {
  switch (error) {
    case 'detached-head':
      return t`Switch to a branch to share.`;
    case 'branch-not-on-origin':
      return branch
        ? t`Push ${branch} to GitHub before sharing.`
        : t`Push this branch to GitHub before sharing.`;
    case 'non-github-remote':
      return t`Sharing supports GitHub remotes only.`;
    case 'invalid-path':
      return t`Can't share this path.`;
    case 'no-remote':
      return t`This project has no GitHub remote.`;
  }
}

export async function runShareAction(
  input: RunShareActionInput,
  deps: ShareActionDeps,
): Promise<RunShareActionResult> {
  if (!input.hasRemote) {
    input.onClickWhenNoRemote();
    return { kind: 'opened-wizard' };
  }

  // `docPath` is the `.md` / `.mdx` content-relative path; `folderPath` is the
  // content-relative folder path passed through unchanged (the empty string is
  // the content-root sentinel).
  const body: ShareConstructUrlRequest =
    input.kind === 'folder'
      ? { kind: 'folder', folderPath: input.folderRelativePath }
      : { kind: 'doc', docPath: docNameToMarkdownPath(input.docName) };

  let response: ShareConstructUrlResponse;
  try {
    response = await requestShareConstructUrl(body, deps.fetchFn);
  } catch {
    deps.toastError(t`Could not construct share URL.`, 'transport');
    return { kind: 'transport-error' };
  }

  if (response.ok) {
    try {
      await deps.clipboardWrite(response.shareUrl);
    } catch {
      // The URL was constructed successfully — only the clipboard write
      // failed. Use a distinct toast so the user knows the share link
      // exists (they can re-trigger or paste manually) rather than
      // assuming the share flow itself failed.
      deps.toastError(t`Link ready but could not copy to clipboard.`, 'clipboard');
      deps.logEvent('[share] action=link-construct result=clipboard-failed');
      return {
        kind: 'clipboard-failed',
        shareUrl: response.shareUrl,
        freshness: response.freshness,
      };
    }
    deps.toastSuccess(input.kind === 'folder' ? t`Folder share link copied.` : t`Link copied.`);
    deps.logEvent('[share] action=link-construct');
    return {
      kind: 'copied',
      shareUrl: response.shareUrl,
      branch: response.branch,
      freshness: response.freshness,
    };
  }

  // Server-side `no-remote` is the wizard's domain too — the client-side
  // `hasRemote` hook can disagree with the server (e.g. a worktree whose
  // parent carries the remote but the OK contentDir is a sibling without
  // its own `.git/`). Routing both detection paths through the wizard
  // keeps the "Share never dead-ends" contract.
  if (response.error === 'no-remote') {
    input.onClickWhenNoRemote();
    return { kind: 'opened-wizard' };
  }

  const branch = response.branch;
  deps.toastError(mapShareErrorToToast(response.error, branch), 'business');
  return { kind: 'business-error', error: response.error, branch };
}
