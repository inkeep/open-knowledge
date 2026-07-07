/**
 * Renderer-side share-receive helpers: error/toast mappers, clone URL
 * builder, and the [receive] log formatter. The decision primitives
 * (`selectCandidate` and friends) live in `@inkeep/open-knowledge-core`
 * and now run main-side as part of share-target resolution; this module
 * only re-exports the few core symbols renderer call sites still consume.
 */

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

/**
 * Construct the GitHub HTTPS clone URL for the clone path. The Clone wizard's
 * URL field accepts the canonical form; `simple-git` clones either form with
 * the same auth flow.
 */
export function buildCloneUrl(expected: ExpectedShareRepo): string {
  return _canonicalGitHubRemoteUrl(expected);
}

/**
 * Translate a folder-validator result into a user-facing toast string for the
 * "I have it locally" path. The dialog reopens the picker on every error so
 * the user can correct their choice without dismissing.
 */
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

/**
 * Map a non-launcher share-received payload to the toast string the dialog
 * should fire. Both fallbacks dismiss the dialog without prompting — the UI
 * never mounts a decision tree for unparseable input.
 */
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

/**
 * Condense raw `git clone` stderr into a single user-facing line for the
 * share-receive error view.
 *
 * Git's clone stderr leads with a `Cloning into '<local path>'...` progress
 * line — noise that also leaks the recipient's local filesystem path — and
 * usually states the cause twice: once on a GitHub `remote:` line (written for
 * humans) and again on a `fatal:` line (which embeds the repo URL). We surface
 * the `remote:` line when present, else the `fatal:` line, with the prefix
 * stripped. There is no official catalog of git-over-HTTPS clone messages;
 * the `remote:` line is GitHub's own phrasing (`Repository not found.`,
 * `Invalid username or password.`, `Permission to X denied to Y.`, ...).
 *
 * Returns an empty string when nothing meaningful survives (e.g. the only line
 * was the progress preamble) so callers can omit the line entirely.
 */
export function formatCloneErrorMessage(detail: string): string {
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Cloning into /i.test(line));

  // Last, not first: a clone that fails after partial progress can emit
  // `remote:` progress lines before the diagnostic `remote:` line, so the last
  // one is the meaningful message. (Manual last-match — `Array.findLast` needs
  // an es2023 lib target this package doesn't set.)
  const remoteLines = lines.filter((line) => /^remote:/i.test(line));
  const remote = remoteLines[remoteLines.length - 1];
  if (remote) return remote.replace(/^remote:\s*/i, '').trim();

  const fatal = lines.find((line) => /^fatal:/i.test(line));
  if (fatal) return fatal.replace(/^fatal:\s*/i, '').trim();

  return lines[0] ?? '';
}

/**
 * Records the git-level branch outcome after the user picks Switch or
 * Open-on-current. Distinct from `BranchDialogAction`, which records the
 * user-visible button click on the dialog itself.
 */
export type BranchAction = 'switch' | 'fallback' | 'fetch-failed' | 'open-current' | 'cancel';

/**
 * Closed enum of the user-visible actions on the branch-switch dialog.
 *
 * `switch` is the user click; `branch-switch-complete` /
 * `branch-switch-timeout` are the terminal outcomes after dismissal gates
 * on the CC1 `branch-switched` broadcast — dismissal MUST NOT fire on
 * checkout HTTP 200 alone.
 */
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
  /** Branch name — not PII for this product (public repo branches). */
  readonly branch?: string;
  /**
   * Result of the `<projectPath>/<path>` target-existence probe (kind-aware:
   * file for `doc`, directory for `folder`). The probe runs main-side now
   * (see `dispatchResolvedShare`); this field stays on the renderer log
   * interface so historical log-parsers don't break.
   */
  readonly doc_check?: CheckTargetExistsResult;
  /** User-visible action taken on the branch-switch dialog. */
  readonly branch_dialog_action?: BranchDialogAction;
}

/**
 * Bracket-prefix structured log line for receive-flow events. Non-PII only —
 * never logs project path, doc filename, owner, repo, or blob URL. Branch
 * names are emitted under `branch=<name>` so the success-metric instrumentation
 * (branch_action=switch|stay|fallback) can be correlated.
 */
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
