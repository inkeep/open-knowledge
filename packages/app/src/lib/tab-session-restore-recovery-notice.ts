import { t } from '@lingui/core/macro';
import { toast } from 'sonner';

const NOTICE_ID = 'ok-tab-session-restore-recovered';

export function showTabSessionRestoreRecoveryNotice(): void {
  toast(t`Your last open document couldn't be restored.`, {
    id: NOTICE_ID,
    description: t`The workspace opened without it so the app could start.`,
    duration: Number.POSITIVE_INFINITY,
  });
}
