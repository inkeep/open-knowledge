import type { HandoffTarget, InstallState, TargetData } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import type { Workspace } from '@/lib/workspace-paths';
import { TargetIcon } from './OpenInAgentMenuItem';
import { buildSelectionOrDocHandoffInput, useHandoffDispatch } from './useHandoffDispatch';
import { useInstalledAgents } from './useInstalledAgents';

export interface EditWithAiSelectionSnapshot {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
  readonly selectionMarkdown: string;
}

interface EditWithAiPanelProps {
  readonly installStates: Record<HandoffTarget, InstallState>;
  /** Fired when the user picks a target; carries the typed instruction —
   *  the empty string when the user dispatched without typing one. */
  readonly onPick: (target: TargetData, instruction: string) => void;
}

export function EditWithAiPanel({ installStates, onPick }: EditWithAiPanelProps): ReactNode {
  const { t } = useLingui();
  const [instruction, setInstruction] = useState('');

  const installedTargets = VISIBLE_TARGETS.filter(
    (target) => installStates[target.id]?.installed === true,
  );
  const probePending = VISIBLE_TARGETS.some(
    (target) => installStates[target.id]?.installed == null,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        <Trans>Edit with AI</Trans>
      </div>
      <Input
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t`What should the AI do? (optional)`}
        aria-label={t`Instruction for the AI`}
        data-testid="edit-with-ai-instruction"
      />
      {installedTargets.length > 0 ? (
        <>
          <div className="text-muted-foreground text-xs" data-testid="edit-with-ai-send-label">
            <Trans>Send to</Trans>
          </div>
          <div className="flex flex-col gap-0.5">
            {installedTargets.map((target) => (
              <Button
                key={target.id}
                type="button"
                variant="ghost"
                className="w-full justify-start gap-2"
                data-testid={`edit-with-ai-target-${target.id}`}
                onClick={() => onPick(target, instruction)}
              >
                <TargetIcon id={target.id} aria-hidden="true" />
                <span>{target.displayName}</span>
              </Button>
            ))}
          </div>
        </>
      ) : (
        <p
          className="text-sm text-muted-foreground"
          data-testid="edit-with-ai-empty"
          aria-live="polite"
        >
          {probePending ? (
            <Trans>Checking for installed agents</Trans>
          ) : (
            <Trans>No installed agents found</Trans>
          )}
        </p>
      )}
    </div>
  );
}

interface EditWithAiPopoverProps {
  /** Controlled open state, owned by the bubble button so the Cmd+Shift+I
   *  shortcut and a trigger click share one popover. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Selection snapshot captured by the caller when the popover opened. Null
   *  while closed; a non-null snapshot is required to dispatch. */
  readonly snapshot: EditWithAiSelectionSnapshot | null;
  readonly children: ReactNode;
}

export function EditWithAiPopover({
  open,
  onOpenChange,
  snapshot,
  children,
}: EditWithAiPopoverProps): ReactNode {
  const { t } = useLingui();
  const { states, refresh } = useInstalledAgents();
  const { dispatch } = useHandoffDispatch();

  const refreshOnOpen = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (open) refreshOnOpen();
  }, [open]);

  const handlePick = (target: TargetData, instruction: string): void => {
    if (snapshot !== null) {
      const input = buildSelectionOrDocHandoffInput({
        docName: snapshot.docName,
        workspace: snapshot.workspace,
        instruction,
        selectionMarkdown: snapshot.selectionMarkdown,
      });
      if (input !== null) {
        void dispatch(target.id, input);
      } else {
        toast.error(t`Couldn't send the selection — please try again.`);
      }
    }
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" aria-label={t`Edit with AI`} data-testid="edit-with-ai-popover">
        <EditWithAiPanel installStates={states} onPick={handlePick} />
      </PopoverContent>
    </Popover>
  );
}
