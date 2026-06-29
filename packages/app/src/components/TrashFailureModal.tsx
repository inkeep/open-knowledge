import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';


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
  const headerDescription = isMulti
    ? plural(count, {
        one: '# item could not be moved to the Trash. Do you want to permanently delete instead?',
        other:
          '# items could not be moved to the Trash. Do you want to permanently delete instead?',
      })
    : only
      ? `${t`Could not move "${targetName}" to the Trash. Do you want to permanently delete instead?`}\n${formatTrashFailureDetail(only)}`
      : t`Do you want to permanently delete instead?`;
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          <Trans>Couldn't move to Trash</Trans>
        </DialogTitle>
        <DialogDescription className="whitespace-pre-wrap">{headerDescription}</DialogDescription>
      </DialogHeader>
      {isMulti ? (
        <DialogBody>
          <ul className="flex flex-col gap-2 text-xs">
            {failedTargets.map((target) => (
              <li key={target.path} data-testid="trash-failure-modal-target">
                <div className="font-mono text-foreground">{displayTargetName(target)}</div>
                <div className="text-muted-foreground">{formatTrashFailureDetail(target)}</div>
              </li>
            ))}
          </ul>
        </DialogBody>
      ) : null}
      <DialogFooter>
        <Button
          variant="outline"
          className="font-mono uppercase"
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="trash-failure-modal-cancel"
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="outline"
          className="font-mono uppercase"
          onClick={onRetry}
          disabled={isSubmitting}
          data-testid="trash-failure-modal-retry"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="size-4 animate-spin" /> <Trans>Retrying</Trans>
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
              <Loader2 className="size-4 animate-spin" /> <Trans>Deleting</Trans>
            </>
          ) : (
            <Trans>Delete Permanently</Trans>
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
