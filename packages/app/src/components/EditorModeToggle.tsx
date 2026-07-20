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
  /** Disables the Markdown (source) option (e.g. doc editor when offline). */
  sourceDisabled?: boolean;
  /**
   * Disables the Visual (wysiwyg) option (e.g. the lint-config editor when the
   * opened file is not the governing root config the rule writer can target).
   */
  wysiwygDisabled?: boolean;
  /**
   * Overrides the default segment labels ("Visual" / "Markdown"), applied to
   * both the tooltip and the accessible name. The lint-config editor passes
   * "Rules" / "Source". Pass an already-translated string so message extraction
   * stays at the call site.
   */
  wysiwygLabel?: string;
  sourceLabel?: string;
  /**
   * Tooltip shown on the Visual segment while `wysiwygDisabled` — explains why
   * the option is unavailable so a pointer user learns the reason.
   */
  wysiwygDisabledReason?: string;
}

/**
 * Visual ⇄ Markdown editor-mode toggle — the segmented control shared by the
 * document editor toolbar (`EditorToolbar`), the skill editor, and the
 * lint-config editor, so all three read identically. Labels default to
 * Visual/Markdown; a caller may relabel the two segments and disable the visual
 * one without affecting the others.
 */
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
  // Stable id so the disabled Visual segment can point `aria-describedby` at a
  // visually-hidden element carrying its reason.
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
          {/* Disabled <button> doesn't fire pointer events; wrap so the tooltip still triggers. */}
          <div>
            <ToggleGroupItem
              value="wysiwyg"
              aria-label={wysiwygName}
              // A disabled <button> is skipped by the toggle's roving tabindex,
              // so its tooltip (pointer-only) never reaches keyboard / screen-
              // reader users. Point `aria-describedby` at a visually-hidden
              // element carrying the reason: `aria-describedby` has broad SR
              // support where the ARIA 1.3 `aria-description` attribute does not.
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
          {/* Disabled <button> doesn't fire pointer events; wrap so the tooltip still triggers. */}
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
