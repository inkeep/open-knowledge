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

export type ShareTargetInput =
  | { kind: 'doc'; docName: string }
  | { kind: 'folder'; folderRelativePath: string };

export function buildDocShareInput(docName: string): ShareTargetInput {
  return { kind: 'doc', docName };
}

export function buildFolderShareInput(folderRelativePath: string): ShareTargetInput {
  return { kind: 'folder', folderRelativePath };
}

export type ShareErrorToastReason = 'transport' | 'clipboard' | 'business';

export interface ShareActionDeps {
  fetchFn?: typeof fetch;
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
    case 'unsupported-share-url':
      return t`This GitHub URL can't be shared.`;
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

  if (response.error === 'no-remote') {
    input.onClickWhenNoRemote();
    return { kind: 'opened-wizard' };
  }

  const branch = response.branch;
  deps.toastError(mapShareErrorToToast(response.error, branch), 'business');
  return { kind: 'business-error', error: response.error, branch };
}
