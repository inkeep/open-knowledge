/**
 * "View in source" entry for the WYSIWYG bubble menu — jumps from the current
 * selection to its markdown source. Activating it flips the editor to source
 * mode and lands the selected block's source range centered and flashed, caret
 * at its start, so a user reading a passage can inspect or fix its markdown
 * without re-scrolling.
 *
 * The jump targets the selection's block: `requestViewInSource` reads the
 * selection start, which is where the bubble bar is anchored anyway.
 *
 * Unlike the icon-only siblings in this bar, this entry is keyboard-operable.
 * The action lives on `onClick`, which a focused button fires from both a mouse
 * click and a keyboard Enter/Space press; `onMouseDown` only suppresses the
 * focus shift so the selection stays painted through the flip, matching the bar
 * convention without moving the action off the keyboard-reachable path.
 */

import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { Markdown } from '@/components/icons/markdown';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { getEditorDocName } from '../extensions/doc-context';
import { requestViewInSource } from '../mode-switch-landing';
import { getYDoc } from '../utils/get-ydoc';

export function ViewInSourceBubbleButton({ editor }: { editor: Editor }): ReactNode {
  const { t } = useLingui();

  const jump = (): void => {
    const docName = getEditorDocName(editor);
    const ydoc = getYDoc(editor);
    // Read the doc identity at activation time, not render time: the pooled
    // editor can be torn down between the bubble rendering and the click. With
    // no registered doc name or Y.Doc there is nothing to navigate into, so the
    // entry no-ops rather than dispatching a flip that would land nowhere.
    if (docName === null || !ydoc) return;
    requestViewInSource({ editor, docName, ytext: ydoc.getText('source') });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="view-in-source-bubble-button"
          className="text-accent-foreground/80"
          aria-label={t`View in source markdown`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={jump}
        >
          <Markdown className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <span>{t`View in source markdown`}</span>
        <Kbd aria-label={formatShortcutLabel('view-source-at-cursor')}>
          {formatShortcut('view-source-at-cursor')}
        </Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
