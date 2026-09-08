import { useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function AttachFilesButton({
  onFiles,
  referencesOnly = false,
  testId,
}: {
  onFiles: (files: readonly File[]) => Promise<void> | void;
  referencesOnly?: boolean;
  testId: string;
}): ReactNode {
  const { t } = useLingui();
  const openFilePicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) void onFiles(files);
    });
    input.click();
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="rounded-lg"
          onClick={openFilePicker}
          aria-label={t`Attach a file`}
          data-testid={testId}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {t`Attach a file`}
        {referencesOnly ? t` · references only (no embedded contents)` : null}
      </TooltipContent>
    </Tooltip>
  );
}
