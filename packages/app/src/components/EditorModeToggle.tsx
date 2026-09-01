import { Trans, useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import { Markdown } from './icons/markdown';
import { Textbox } from './icons/textbox';

interface EditorModeToggleProps {
  isSourceMode: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  sourceDisabled?: boolean;
  wysiwygDisabled?: boolean;
  wysiwygLabel?: string;
  sourceLabel?: string;
  wysiwygDisabledReason?: string;
}

export function EditorModeToggle({
  isSourceMode,
  onModeChange,
  sourceDisabled = false,
  wysiwygDisabled = false,
  wysiwygLabel,
  sourceLabel,
  wysiwygDisabledReason,
}: EditorModeToggleProps) {
  const { t } = useLingui();
  const wysiwygName = wysiwygLabel ?? t`Visual editor`;
  const sourceName = sourceLabel ?? t`Markdown source`;
  const wysiwygReasonId = useId();
  const describeWysiwyg = wysiwygDisabled && wysiwygDisabledReason ? wysiwygDisabledReason : null;
  return (
    <ToggleGroup
      type="single"
      value={isSourceMode ? 'source' : 'wysiwyg'}
      onValueChange={(v: EditorModeValue | '') => {
        if (v) onModeChange(v);
      }}
      aria-label={t`Editor mode`}
      variant="segmented"
      size="sm"
      spacing={1}
      className="shrink-0 bg-muted p-0.5 data-[size=sm]:rounded-[10px]"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {}
          <div>
            <ToggleGroupItem
              value="wysiwyg"
              aria-label={wysiwygName}
              aria-describedby={describeWysiwyg ? wysiwygReasonId : undefined}
              disabled={wysiwygDisabled}
              className="size-7 px-0 dark:data-[state=on]:bg-foreground/15"
            >
              <Textbox className="size-4" />
            </ToggleGroupItem>
            {describeWysiwyg ? (
              <span id={wysiwygReasonId} className="sr-only">
                {describeWysiwyg}
              </span>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {wysiwygDisabled && wysiwygDisabledReason ? (
            wysiwygDisabledReason
          ) : wysiwygLabel ? (
            wysiwygLabel
          ) : (
            <Trans>Visual</Trans>
          )}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {}
          <div>
            <ToggleGroupItem
              value="source"
              aria-label={sourceName}
              disabled={sourceDisabled}
              className="size-7 px-0 dark:data-[state=on]:bg-foreground/15"
            >
              <Markdown className="size-4" />
            </ToggleGroupItem>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sourceDisabled ? (
            <Trans>
              Source mode requires a live connection — your edits are saved and will appear when you
              reconnect.
            </Trans>
          ) : sourceLabel ? (
            sourceLabel
          ) : (
            <Trans>Markdown</Trans>
          )}
        </TooltipContent>
      </Tooltip>
    </ToggleGroup>
  );
}
