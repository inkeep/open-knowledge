// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { Children, type ReactNode } from 'react';
import { FileEntryPathIcon } from '@/components/file-entry-icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function chipBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function FileChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const { t } = useLingui();
  const label = chipBasename(path);
  const removeLabel = t`Remove ${label} from context`;
  return (
    <span
      data-testid={`composer-context-chip-file-${path}`}
      title={path}
      className="group/chip inline-flex max-w-[14rem] items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-1.5 pl-1 text-muted-foreground text-xs"
    >
      {}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={removeLabel}
        onClick={onRemove}
        onKeyDown={(event) => {
          if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            onRemove();
          }
        }}
        className="group/remove relative size-3.5 shrink-0 rounded-sm text-muted-foreground/80 hover:text-foreground"
      >
        <span className="absolute top-1/2 left-1/2 inline-flex size-3 -translate-x-1/2 -translate-y-1/2 opacity-100 transition-opacity duration-150 ease-out group-hover/chip:opacity-0 group-focus-within/chip:opacity-0 motion-reduce:transition-none">
          <FileEntryPathIcon path={path} className="size-3" showExtensionBadge={false} />
        </span>
        <X
          className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 motion-reduce:transition-none"
          aria-hidden
        />
      </Button>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

export function ComposerContextChips({
  files = [],
  onRemoveFile,
  className,
  children,
}: {
  files?: readonly string[];
  onRemoveFile?: (path: string) => void;
  className?: string;
  children?: ReactNode;
}) {
  if (files.length === 0 && Children.toArray(children).length === 0) return null;
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      data-testid="composer-context-chips"
    >
      {files.map((path) => (
        <FileChip key={path} path={path} onRemove={() => onRemoveFile?.(path)} />
      ))}
      {children}
    </div>
  );
}
