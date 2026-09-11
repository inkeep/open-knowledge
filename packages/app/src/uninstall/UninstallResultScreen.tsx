import type { UninstallNoticeScreen as UninstallNoticeSpec } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { UninstallNoticeScreen } from './UninstallNoticeScreen';

export function UninstallResultScreen({
  outcome,
  onConfirm,
  onCancel,
  onRevealLog,
}: {
  outcome: 'success' | 'failure';
  onConfirm: () => void;
  onCancel: () => void;
  onRevealLog: () => void;
}) {
  const { t } = useLingui();
  const notice: UninstallNoticeSpec =
    outcome === 'failure'
      ? {
          title: t`Cleanup didn’t finish`,
          paragraphs: [
            t`Some files may not have been removed. Open the cleanup log for details. You can reopen OpenKnowledge to try again.`,
          ],
          confirmLabel: t`Close`,
          logRevealLabel: t`Cleanup log`,
        }
      : {
          title: t`OpenKnowledge files were removed`,
          subtitle: t`Almost done. Here's what happened and what's left.`,
          paragraphs: [],
          checklist: [
            {
              label: t`Kept your content`,
              detail: t`Markdown files and authored skills were left untouched.`,
              done: true,
            },
            {
              label: t`Removed OpenKnowledge files`,
              detail: t`Settings and integrations were cleaned up.`,
              done: true,
            },
            {
              label: t`Move OpenKnowledge.app to the Trash`,
              detail: t`Reveal in Finder shows the app so you can drag it to the Trash.`,
              done: false,
            },
          ],
          logRevealLabel: t`Cleanup log`,
          confirmLabel: t`Reveal in Finder`,
        };
  return (
    <UninstallNoticeScreen
      notice={notice}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onRevealLog={onRevealLog}
    />
  );
}
