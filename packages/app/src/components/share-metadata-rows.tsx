/**
 * Shared share-target metadata block used by both ShareReceiveDialog
 * (launcher) and ShareBranchSwitchDialog (editor shell). Renders the
 * repository / file / branch rows as semantic <dl> markup. The Branch row
 * is suppressed for well-known default branches so the common case stays
 * uncluttered.
 *
 * The `data-testid` is caller-supplied so each dialog keeps its own
 * downstream e2e selectors.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(['main', 'master']);

export interface ShareMetadataRowsProps {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  /**
   * Share-target kind — drives the path row's label ("Folder" vs "File").
   * Defaults to `'doc'` for back-compat with call sites that predate
   * folder shares.
   */
  kind?: 'doc' | 'folder';
  /** Test id for the outer <dl> (each dialog scopes its own selector). */
  testId: string;
  /** Test id for the branch <dd> value (downstream branch-row selection). */
  branchTestId: string;
}

export function ShareMetadataRows({
  owner,
  repo,
  path,
  branch,
  kind = 'doc',
  testId,
  branchTestId,
}: ShareMetadataRowsProps) {
  const showBranch = branch !== '' && !DEFAULT_BRANCH_NAMES.has(branch);
  return (
    <dl className="space-y-2 text-1sm text-muted-foreground" data-testid={testId}>
      <ShareMetadataRow label={<Trans>Repository</Trans>}>
        <span>
          {owner}/{repo}
        </span>
      </ShareMetadataRow>
      {path ? (
        <ShareMetadataRow label={kind === 'folder' ? <Trans>Folder</Trans> : <Trans>File</Trans>}>
          <span className="font-mono" data-testid={`${testId}-target`}>
            {path}
          </span>
        </ShareMetadataRow>
      ) : null}
      {showBranch ? (
        <ShareMetadataRow label={<Trans>Branch</Trans>}>
          <span className="font-mono" data-testid={branchTestId}>
            {branch}
          </span>
        </ShareMetadataRow>
      ) : null}
    </dl>
  );
}

interface ShareMetadataRowProps {
  label: ReactNode;
  children: ReactNode;
}

function ShareMetadataRow({ label, children }: ShareMetadataRowProps) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-20 shrink-0 font-mono uppercase tracking-wide text-xs">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-foreground">{children}</dd>
    </div>
  );
}
