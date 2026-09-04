import {
  canonicalGitHubRemoteUrl as _canonicalGitHubRemoteUrl,
  type ExpectedShareRepo,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import type {
  CheckTargetExistsResult,
  OkShareReceivedPayload,
  ShareFolderValidationResult,
} from '@/lib/desktop-bridge-types';
import type { VerdictCellKind, WorktreeCheckoutSideEffectReason } from './branch-switch-flow';

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
  const expectedOwner = expected.owner;
  const expectedRepo = expected.repo;
  const expectedHost = expected.host;
  switch (result.kind) {
    case 'ok':
      return null;
    case 'not-git':
      return t`This folder doesn't contain a git repository. Pick a different folder?`;
    case 'wrong-repo': {
      const actualOwner = result.actualOwner;
      const actualRepo = result.actualRepo;
      return t`This folder is a clone of ${actualOwner}/${actualRepo}, not ${expectedOwner}/${expectedRepo}. Pick a different folder?`;
    }
    case 'wrong-host': {
      const actualHost = result.actualHost;
      return t`This folder is a clone of ${expectedOwner}/${expectedRepo} on ${actualHost}, not ${expectedHost}. Pick a folder cloned from ${expectedHost}?`;
    }
    case 'no-origin':
    case 'non-github':
    case 'symlink-escape':
      return t`This folder isn't a clone of ${expectedOwner}/${expectedRepo}. Pick a different folder?`;
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
      message: t`Update OpenKnowledge to open this share.`,
    };
  }
  if (payload.kind === 'invalid') {
    return { kind: 'invalid', message: t`Invalid share URL.` };
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
  | 'branch-switch-timeout'
  | 'open-worktree'
  | `open-worktree-failed:${WorktreeCheckoutSideEffectReason}`;

export interface ReceiveLogFields {
  readonly q2_path?: 'clone' | 'local';
  readonly folder_validate?: ShareFolderValidationResult['kind'];
  readonly branch_action?: BranchAction;
  readonly branch?: string;
  readonly doc_check?: CheckTargetExistsResult;
  readonly branch_dialog_action?: BranchDialogAction;
  readonly verdict_cell?: VerdictCellKind;
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
  if (fields.verdict_cell !== undefined) parts.push(`verdict_cell=${fields.verdict_cell}`);
  return parts.join(' ');
}
