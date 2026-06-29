
import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
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
}

export function CopyButton({
  copyContent,
  clipboardWrite = defaultClipboardWrite,
  initialCopied = false,
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
        () => {
        },
      );
  };

  const label = copied ? t`Copied!` : t`Copy`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onClick={handleClick}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
