import { useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PlanEntry } from '@/lib/acp/thread-event-model';
import { cn } from '@/lib/utils';

export interface PlanApprovalHandlers {
  onApprove: () => void;
  onAskChanges: () => void;
  onReject: () => void;
}

export function PlanChecklist({
  plan,
  approval,
}: {
  plan: readonly PlanEntry[];
  approval?: PlanApprovalHandlers;
}): ReactNode {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const done = plan.filter((p) => p.status === 'completed').length;
  const hasPending = plan.some((p) => p.status !== 'completed');
  const showApprovals = approval !== undefined && hasPending;

  useEffect(() => {
    if (showApprovals) setOpen(true);
  }, [showApprovals]);

  return (
    <div className="border-border/60 border-b bg-muted/30 px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start gap-1.5 p-0 font-medium text-muted-foreground text-xs hover:bg-transparent"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="agent-thread-plan-toggle"
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
        <span>{t`Plan (${done}/${plan.length})`}</span>
      </Button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="agent-thread-plan-list">
          {plan.map((entry, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: plan is a positional list
              key={index}
              className={cn(
                'flex items-start gap-1.5 text-xs',
                entry.status === 'completed' && 'text-muted-foreground line-through',
              )}
            >
              <span aria-hidden="true">{entry.status === 'completed' ? '☑' : '☐'}</span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {showApprovals ? (
        <div
          className="mt-1.5 flex items-center justify-end gap-1"
          data-testid="agent-thread-plan-approval"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground text-xs hover:text-foreground"
            onClick={approval.onReject}
            data-testid="agent-thread-plan-approval-reject"
          >
            {t`Reject`}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={approval.onAskChanges}
            data-testid="agent-thread-plan-approval-ask-changes"
          >
            {t`Ask changes…`}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 text-xs"
            onClick={approval.onApprove}
            data-testid="agent-thread-plan-approval-approve"
          >
            {t`Approve & proceed`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
