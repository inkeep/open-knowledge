
import {
  canonicalGitHubRemoteUrl as _canonicalGitHubRemoteUrl,
  type ExpectedShareRepo,
} from '@inkeep/open-knowledge-core';
import type {
  CheckTargetExistsResult,
  OkShareReceivedPayload,
  ShareFolderValidationResult,
} from '@/lib/desktop-bridge-types';

export {
  type BranchMatchOutcome,
  canonicalGitHubRemoteUrl,
  type ExpectedShareRepo,
} from '@inkeep/open-knowledge-core';

export function buildCloneUrl(expected: ExpectedShareRepo): string {
  return _canonicalGitHubRemoteUrl(expected);
}

export function mapValidationToToast(
  result: ShareFolderValidationResult,
  expected: ExpectedShareRepo,
): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'not-git':
      return "This folder doesn't contain a git repository. Pick a different folder?";
    case 'wrong-repo':
      return `This folder is a clone of ${result.actualOwner}/${result.actualRepo}, not ${expected.owner}/${expected.repo}. Pick a different folder?`;
    case 'no-origin':
    case 'non-github':
    case 'symlink-escape':
      return `This folder isn't a clone of ${expected.owner}/${expected.repo}. Pick a different folder?`;
  }
}

export type ReceiveErrorPresentation =
  | { readonly kind: 'unsupported-version'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | null;

export function presentReceiveError(payload: OkShareReceivedPayload): ReceiveErrorPresentation {
  if (payload.kind === 'unsupported-version') {
    return {
      kind: 'unsupported-version',
      message: 'Update OpenKnowledge to open this share.',
    };
  }
  if (payload.kind === 'invalid') {
    return { kind: 'invalid', message: 'Invalid share URL.' };
  }
  return null;
}

export function formatCloneErrorMessage(detail: string): string {
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Cloning into /i.test(line));

  const remoteLines = lines.filter((line) => /^remote:/i.test(line));
  const remote = remoteLines[remoteLines.length - 1];
  if (remote) return remote.replace(/^remote:\s*/i, '').trim();

  const fatal = lines.find((line) => /^fatal:/i.test(line));
  if (fatal) return fatal.replace(/^fatal:\s*/i, '').trim();

  return lines[0] ?? '';
}

export type BranchAction = 'switch' | 'fallback' | 'fetch-failed' | 'open-current' | 'cancel';

export type BranchDialogAction =
  | 'switch'
  | 'open-current'
  | 'cancel'
  | 'pivot-to-other-worktree'
  | 'branch-switch-complete'
  | 'branch-switch-timeout';

export interface ReceiveLogFields {
  readonly q2_path?: 'clone' | 'local';
  readonly folder_validate?: ShareFolderValidationResult['kind'];
  readonly branch_action?: BranchAction;
  readonly branch?: string;
  readonly doc_check?: CheckTargetExistsResult;
  readonly branch_dialog_action?: BranchDialogAction;
}

export function formatReceiveLog(fields: ReceiveLogFields): string {
  const parts: string[] = ['[receive]'];
  if (fields.q2_path !== undefined) parts.push(`q2_path=${fields.q2_path}`);
  if (fields.folder_validate !== undefined) {
    parts.push(`folder_validate=${fields.folder_validate}`);
  }
  if (fields.branch_action !== undefined) parts.push(`branch_action=${fields.branch_action}`);
  if (fields.branch !== undefined) parts.push(`branch=${fields.branch}`);
  if (fields.doc_check !== undefined) parts.push(`doc_check=${fields.doc_check}`);
  if (fields.branch_dialog_action !== undefined) {
    parts.push(`branch_dialog_action=${fields.branch_dialog_action}`);
  }
  return parts.join(' ');
}
