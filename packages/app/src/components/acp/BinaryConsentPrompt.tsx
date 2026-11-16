import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { getAgentThreadClient } from '@/lib/acp/thread-client';
import type { RenderedItem } from '@/lib/acp/thread-event-model';

export function BinaryConsentPrompt({
  item,
  threadId,
  actionable,
}: {
  item: Extract<RenderedItem, { kind: 'binary_consent' }>;
  threadId: string;
  actionable: boolean;
}): ReactNode {
  const { t } = useLingui();
  const client = getAgentThreadClient();
  const [submittedDecision, setSubmittedDecision] = useState<{
    requestId: string;
    kind: 'granted' | 'declined';
  } | null>(null);
  const localDecision =
    submittedDecision?.requestId === item.requestId ? submittedDecision.kind : null;
  const resolution = item.resolved ?? localDecision;
  const respond = (kind: 'granted' | 'declined') => {
    const sent = client.respondBinaryConsent(threadId, item.requestId, { kind });
    if (kind === 'declined' || sent) setSubmittedDecision({ requestId: item.requestId, kind });
  };
  const title = t`Run ${item.agentName} ${item.version} without verification?`;
  const warning = t`No checksum is available to verify this agent. Approval is required for every run, including installed copies. This agent will run with your permissions. Continue only if you trust the source below.`;
  if (actionable && resolution === null) {
    return (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) {
            respond('declined');
          }
        }}
      >
        <AlertDialogContent data-testid="agent-thread-binary-consent">
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            <AlertDialogDescription>
              {warning}
              <span className="mt-3 block break-all font-mono" dir="ltr">
                {new URL(item.archive).host}
              </span>
              <span className="mt-1 block break-all font-mono text-xs" dir="ltr">
                {item.archive}
              </span>
            </AlertDialogDescription>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline-mono">{t`Not now`}</AlertDialogCancel>
            <Button onClick={() => respond('granted')}>{t`Trust source and continue`}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <div
      className="rounded-md border border-warning/40 px-2.5 py-2 text-sm"
      data-testid="agent-thread-binary-consent"
    >
      <p className="mb-1 font-medium">{title}</p>
      <p className="mb-2 text-muted-foreground text-xs">{warning}</p>
      <p className="mb-2 break-all font-mono text-xs" dir="ltr">
        {item.archive}
      </p>
      {resolution === null ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            disabled={!actionable}
            type="button"
            size="sm"
            variant="outline-mono"
            onClick={() => respond('declined')}
          >{t`Not now`}</Button>
          <Button
            disabled={!actionable}
            type="button"
            size="sm"
            onClick={() => respond('granted')}
          >{t`Trust source and continue`}</Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {resolution === 'granted'
            ? t`Approved without verification`
            : resolution === 'declined'
              ? t`Not approved`
              : resolution === 'closed'
                ? t`Cancelled`
                : t`Approval request timed out`}
        </p>
      )}
    </div>
  );
}
