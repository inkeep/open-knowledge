
import { useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { FileEntryPathIcon } from '@/components/file-entry-icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Last path segment of a workspace-relative path — the compact chip label
 *  (`specs/foo/SPEC.md` → `SPEC.md`), Cursor-style. Falls back to the whole
 *  string when there is no slash. */
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
      {/* The LEADING icon IS the remove control (Cursor pattern): no trailing ×,
          no reserved trailing slot. The button is a fixed-size cell holding two
          stacked glyphs — the file icon and the X — and the swap is a pure
          opacity cross-fade in that one cell. The cell never changes size, so the
          chip box is identical at rest vs hover → no reflow, no flicker. At rest
          the file glyph shows (opacity 1, X opacity 0); on chip hover /
          `:focus-within` / button focus they cross-fade (file → 0, X → 1). The
          button stays focusable so Enter/Space/click removes; Backspace/Delete on
          it removes too (keyboard parity). opacity only — never layout. */}
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
          <FileEntryPathIcon path={path} className="size-3" />
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
  files,
  onRemoveFile,
  className,
  children,
}: {
  /** Ordered set of workspace-relative file paths to show as removable top-row
   *  chips (already deduped against inline mentions + sticky-dismissed by the
   *  host). Empty → only `children` (if any) render. */
  files: readonly string[];
  onRemoveFile: (path: string) => void;
  className?: string;
  /** Extra context chips rendered as siblings in the SAME flex-wrap row (e.g.
   *  the captured-selection pill), so every reference shares one wrapping row and
   *  only breaks to a second line on overflow. A child carrying `basis-full`
   *  (the expanded selection preview) drops onto its own line beneath the chips. */
  children?: ReactNode;
}) {
  if (files.length === 0 && children == null) return null;
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      data-testid="composer-context-chips"
    >
      {files.map((path) => (
        <FileChip key={path} path={path} onRemove={() => onRemoveFile(path)} />
      ))}
      {children}
    </div>
  );
}
