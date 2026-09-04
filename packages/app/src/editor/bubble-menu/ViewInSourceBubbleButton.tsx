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
