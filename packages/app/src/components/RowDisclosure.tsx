import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function RowDisclosure({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link-muted"
          size="sm"
          className="absolute end-3 top-2 px-1 text-1sm font-normal underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
          data-testid={testId}
        >
          <Trans comment="Button on each setup row that opens the list of files that row writes to">
            What changes?
          </Trans>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={title}
        className="max-h-(--radix-popover-content-available-height) w-96 max-w-(--radix-popover-content-available-width) overflow-y-auto p-3 subtle-scrollbar"
      >
        {}
        <div className="flex flex-col gap-2 text-xs leading-normal">
          <span className="font-mono text-2xs text-muted-foreground uppercase tracking-wide">
            {title}
          </span>
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
