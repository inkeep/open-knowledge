import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const COPIED_RESET_MS = 1500;

async function defaultClipboardWrite(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('clipboard unavailable');
  }
  await navigator.clipboard.writeText(text);
}

export interface CopyButtonProps {
  copyContent: string;
  clipboardWrite?: (text: string) => Promise<void>;
  initialCopied?: boolean;
  size?: Extract<React.ComponentProps<typeof Button>['size'], 'icon-xs' | 'icon-sm'>;
  ariaLabel?: string;
  testId?: string;
}

export function CopyButton({
  copyContent,
  clipboardWrite = defaultClipboardWrite,
  initialCopied = false,
  size = 'icon-sm',
  ariaLabel,
  testId,
}: CopyButtonProps) {
  const { t } = useLingui();
  const [copyTick, setCopyTick] = useState(initialCopied ? 1 : 0);
  const copied = copyTick > 0;

  useEffect(() => {
    if (copyTick === 0) return;
    const id = setTimeout(() => setCopyTick(0), COPIED_RESET_MS);
    return () => clearTimeout(id);
  }, [copyTick]);

  const handleClick = () => {
    Promise.resolve()
      .then(() => clipboardWrite(copyContent))
      .then(
        () => setCopyTick((n) => n + 1),
        () => {},
      );
  };

  const buttonLabel = copied ? t`Copied!` : (ariaLabel ?? t`Copy`);

  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant="ghost"
          aria-label={buttonLabel}
          onClick={handleClick}
          data-testid={testId}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{buttonLabel}</TooltipContent>
    </Tooltip>
  );
}
