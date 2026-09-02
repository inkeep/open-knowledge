import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { trashNounLabel } from '@/lib/platform-labels';

type TrashFailureReason = 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';

const TRASH_FAILURE_REASONS: ReadonlyArray<TrashFailureReason> = [
  'not-found',
  'permission-denied',
  'system-error',
  'path-escape',
];

export function coerceTrashFailureReason(reason: unknown): TrashFailureReason {
  return typeof reason === 'string' &&
    (TRASH_FAILURE_REASONS as ReadonlyArray<string>).includes(reason)
    ? (reason as TrashFailureReason)
    : 'system-error';
}

export interface TrashFailedTarget {
  kind: 'folder' | 'file' | 'asset';
  path: string;
  name: string;
  reason: TrashFailureReason;
  detail?: string;
}

interface TrashFailureModalProps {
  failedTargets: ReadonlyArray<TrashFailedTarget>;
  isSubmitting: boolean;
  onDeletePermanently: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
  onCancel: () => void;
}

function trashReasonLabel(reason: TrashFailureReason): string {
  switch (reason) {
    case 'not-found':
      return t`File not found`;
    case 'permission-denied':
      return t`Permission denied`;
    case 'system-error':
      return t`System error`;
    case 'path-escape':
      return t`Path resolves outside project`;
  }
}

export function formatTrashFailureDetail(target: TrashFailedTarget): string {
  const reason = trashReasonLabel(target.reason);
  const osDetail = target.detail;
  return osDetail ? t`Reason: ${reason} (${osDetail})` : t`Reason: ${reason}`;
}

function displayTargetName(target: TrashFailedTarget): string {
  return target.kind === 'folder' ? `${target.name}/` : target.name;
}

export function TrashFailureModal({
  failedTargets,
  isSubmitting,
  onDeletePermanently,
  onRetry,
  onCancel,
}: TrashFailureModalProps) {
  const isMulti = failedTargets.length > 1;
  const only = failedTargets[0];
  const count = failedTargets.length;
  const targetName = only ? displayTargetName(only) : '';
  const trashNoun = trashNounLabel(
    typeof window !== 'undefined' ? window.okDesktop?.platform : undefined,
  );
  const headerDescription = isMulti
    ? plural(count, {
        one: `# item could not be moved to the ${trashNoun}. Do you want to permanently delete instead?`,
        other: `# items could not be moved to the ${trashNoun}. Do you want to permanently delete instead?`,
      })
    : only
      ? `${t`Could not move "${targetName}" to the ${trashNoun}. Do you want to permanently delete instead?`}\n${formatTrashFailureDetail(only)}`
      : t`Do you want to permanently delete instead?`;
  return (
    <AlertDialogContent className="sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle>{t`Couldn't move to ${trashNoun}`}</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-wrap">
          {headerDescription}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {isMulti ? (
        <AlertDialogBody>
          <ul className="flex flex-col gap-2 text-xs">
            {failedTargets.map((target) => (
              <li key={target.path} data-testid="trash-failure-modal-target">
                <div className="font-mono text-foreground">{displayTargetName(target)}</div>
                <div className="text-muted-foreground">{formatTrashFailureDetail(target)}</div>
              </li>
            ))}
          </ul>
        </AlertDialogBody>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="trash-failure-modal-cancel"
        >
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        {}
        <Button
          variant="outline"
          className="font-mono uppercase"
          onClick={onRetry}
          disabled={isSubmitting}
          data-testid="trash-failure-modal-retry"
        >
          {isSubmitting ? (
            <>
              <Spinner aria-hidden="true" className="size-4" /> <Trans>Retrying</Trans>
            </>
          ) : (
            <Trans>Retry</Trans>
          )}
        </Button>
        <Button
          variant="destructive"
          onClick={onDeletePermanently}
          disabled={isSubmitting}
          data-testid="trash-failure-modal-delete-permanently"
        >
          {isSubmitting ? (
            <>
              <Spinner aria-hidden="true" className="size-4" /> <Trans>Deleting</Trans>
            </>
          ) : (
            <Trans>Delete Permanently</Trans>
          )}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
