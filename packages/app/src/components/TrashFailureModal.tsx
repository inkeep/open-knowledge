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

/**
 * VSCode-parity fallback modal. When `shell.trashItem` fails for one or more
 * targets, this modal asks the user whether to fall back to
 * a hard delete via `POST /api/delete-path` (which bypasses the OS Trash and
 * uses `unlinkSync`/`rmSync`), to retry the IPC call, or to cancel.
 *
 * Copy is VSCode-parity (split into AlertDialogTitle + AlertDialogDescription
 * so the `text-base leading-none` title primitive doesn't wrap a 2-sentence
 * string to 3 lines with zero leading; semantics preserved):
 *   Title:       "Couldn't move to Trash"
 *   Description: "<target context> Do you want to permanently delete instead?"
 *                (per-target detail appended for single-target failures)
 *   Buttons:     [Cancel] [Retry] [Delete Permanently]
 *
 * Button visual order follows macOS HIG + the sibling DeleteConfirmationDialog
 * precedent: Cancel on the left, Retry in the middle, Delete Permanently on
 * the right as the destructive primary action.
 *
 * Tab close happens AFTER trash IPC success in the caller;
 * Cancel here just dismisses the modal — the user's editor tab is still open.
 * No special handling needed in this component.
 */

/**
 * **DRIFT WARNING — this display-only union mirrors the reason declared on
 * `OkDesktopBridge.shell.trashItem` in the canonical core desktop-bridge
 * contract.** Keep the two unions in lockstep.
 *
 * TypeScript catches structural drift at the bridge-contract level (the cast
 * site in FileTree.tsx narrows via `coerceTrashFailureReason` below); the
 * unions themselves must stay structurally identical.
 */
type TrashFailureReason = 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';

const TRASH_FAILURE_REASONS: ReadonlyArray<TrashFailureReason> = [
  'not-found',
  'permission-denied',
  'system-error',
  'path-escape',
];

/**
 * Narrow an unknown IPC `reason` string back to `TrashFailureReason` at the
 * trust boundary. The IPC wire is a different process, so the declared
 * TypeScript shape isn't a runtime
 * guarantee — a future contract bump that widens the union would silently
 * land an unmapped reason in `trashReasonLabel` (TypeScript would be happy,
 * the switch would hit no case). Defaults to `'system-error'` so the user
 * sees a generic recoverable message rather than a blank row.
 */
export function coerceTrashFailureReason(reason: unknown): TrashFailureReason {
  return typeof reason === 'string' &&
    (TRASH_FAILURE_REASONS as ReadonlyArray<string>).includes(reason)
    ? (reason as TrashFailureReason)
    : 'system-error';
}

export interface TrashFailedTarget {
  kind: 'folder' | 'file' | 'asset';
  /** Project-relative or absolute path; used as the React key (must be unique). */
  path: string;
  /** Basename + extension for display. */
  name: string;
  reason: TrashFailureReason;
  /** Free-form OS message (e.g. NSError.localizedDescription). */
  detail?: string;
}

interface TrashFailureModalProps {
  failedTargets: ReadonlyArray<TrashFailedTarget>;
  isSubmitting: boolean;
  onDeletePermanently: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
  onCancel: () => void;
}

// This file localizes via the `@lingui/core/macro` `t`/`plural` throughout —
// component body included — rather than `useLingui()`. `formatTrashFailureDetail`
// is a module-level helper (exported + unit-tested) that can't call the hook, so
// the core macro is required there; using it consistently file-wide is cleaner
// than mixing core macros in the helper with `useLingui` in the component.

/** Localized label for each trash-failure reason. */
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
        {/* Retry and Delete Permanently stay plain Buttons: both await IPC and
            report progress in their own labels, and an AlertDialogAction would
            close the dialog on activation. Retry in particular must keep the
            dialog mounted so a second failure can repopulate the same list. */}
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
