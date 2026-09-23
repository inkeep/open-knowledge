import { useLingui } from '@lingui/react/macro';
import { Paperclip } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openFilePicker } from '@/lib/file-picker';

export function AttachFilesButton({
  onFiles,
  referencesOnly = false,
  testId,
  size = 'icon-sm',
}: {
  onFiles: (files: readonly File[]) => Promise<void> | void;
  referencesOnly?: boolean;
  testId: string;
  size?: Extract<ComponentProps<typeof Button>['size'], 'icon-sm' | 'icon'>;
}): ReactNode {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant="ghost"
          className="rounded-lg"
          onClick={() => openFilePicker({ multiple: true, onFiles })}
          aria-label={t`Attach a file`}
          data-testid={testId}
        >
          <Paperclip className="size-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {t`Attach a file`}
        {referencesOnly ? t` · references only (no embedded contents)` : null}
      </TooltipContent>
    </Tooltip>
  );
}
