
import { Trans } from '@lingui/react/macro';
import { isMacOS } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { emitOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';

function isNativeTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

export function EditWithAiBubbleButton({
  editor: _editor,
  shortcutEnabled = false,
}: {
  editor: Editor;
  shortcutEnabled?: boolean;
}): ReactNode {
  const isMac = isMacOS();
  const isEmbedded = useIsEmbedded();
  if (!isMac || isEmbedded) return null;

  return <EditWithAiBubbleMenu shortcutEnabled={shortcutEnabled} />;
}

function EditWithAiBubbleMenu({ shortcutEnabled }: { shortcutEnabled: boolean }): ReactNode {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shortcutEnabled) return;
      if (!matchesKeyboardShortcut(event, 'edit-with-ai')) return;
      if (isNativeTextControl(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      emitOpenAskAiComposer();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [shortcutEnabled]);

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 h-5 data-vertical:self-center" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="edit-with-ai-bubble-button"
        className="gap-1 px-2 text-sm font-medium text-accent-foreground/80"
        onClick={() => emitOpenAskAiComposer()}
      >
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>
          <Trans>Ask AI</Trans>
        </span>
      </Button>
    </>
  );
}
