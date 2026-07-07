import { Trans, useLingui } from '@lingui/react/macro';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import { Markdown } from './icons/markdown';
import { Textbox } from './icons/textbox';

interface EditorModeToggleProps {
  isSourceMode: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  /** Disables the Markdown (source) option (e.g. doc editor when offline). */
  sourceDisabled?: boolean;
}

/**
 * Visual ⇄ Markdown editor-mode toggle — the segmented control shared by the
 * document editor toolbar (`EditorToolbar`) and the skill editor, so both read
 * identically.
 */
export function EditorModeToggle({
  isSourceMode,
  onModeChange,
  sourceDisabled = false,
}: EditorModeToggleProps) {
  const { t } = useLingui();
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
        <ToggleGroupItem
          value="wysiwyg"
          aria-label={t`Visual editor`}
          className="size-7 px-0 dark:data-[state=on]:bg-foreground/15"
          asChild
        >
          <TooltipTrigger>
            <Textbox className="size-4" />
          </TooltipTrigger>
        </ToggleGroupItem>
        <TooltipContent side="bottom">
          <Trans>Visual</Trans>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled <button> doesn't fire pointer events; wrap so the tooltip still triggers. */}
          <div>
            <ToggleGroupItem
              value="source"
              aria-label={t`Markdown source`}
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
          ) : (
            <Trans>Markdown</Trans>
          )}
        </TooltipContent>
      </Tooltip>
    </ToggleGroup>
  );
}
