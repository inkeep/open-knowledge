/**
 * Searchable multi-select folder picker that authors `appliesTo` globs for a
 * frontmatter schema mapping. A hand-typed bare folder name (`blog`) is an
 * exact-doc pattern that silently validates nothing; picking the folder writes
 * the `blog/**` the author meant, and the generated pattern lands in the
 * sibling pill input — the raw-glob escape hatch this picker never rewrites.
 *
 * Selection toggles without closing the popover: the list is multi-select.
 */

import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Check, ChevronsUpDown, FolderTree } from 'lucide-react';
import { useId, useState } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  buildFolderRows,
  coveredByAncestor,
  docCountsByFolder,
  folderOfGlob,
  folderRecursiveGlob,
  selectedFolders,
  toggleFolderGlob,
} from './applies-to-folder-globs';

export function AppliesToFolderPicker({
  file,
  globs,
  disabled,
  onChange,
}: {
  /** Schema file the mapping belongs to — namespaces test ids. */
  file: string;
  /** The authored pattern list, exactly as the pill input holds it. */
  globs: string[];
  disabled: boolean;
  onChange: (globs: string[]) => void;
}) {
  const { t } = useLingui();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const pageList = useOptionalPageList();
  // No provider (bare test mounts) — the pill input remains the full editor.
  if (pageList === null) return null;

  const rows = buildFolderRows(pageList.folderPaths).filter(
    (row) => folderOfGlob(folderRecursiveGlob(row.path)) === row.path,
  );
  const counts = docCountsByFolder(pageList.pages);
  const selected = selectedFolders(globs);
  const pickerLabel = t`Pick folders this schema applies to`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          // The listbox is portaled-on-open by Radix, so the id doesn't
          // resolve while closed. Per WAI-ARIA APG combobox pattern, gate
          // aria-controls on `open`.
          aria-controls={open ? listboxId : undefined}
          aria-label={pickerLabel}
          disabled={disabled}
          className="h-7 w-full justify-between font-normal"
          data-testid={`frontmatter-schema-pick-folders-${file}`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderTree aria-hidden className="size-3.5 shrink-0 opacity-60" />
            <span
              className={cn('truncate text-xs', selected.size === 0 && 'text-muted-foreground')}
            >
              {selected.size === 0 ? (
                <Trans>Pick folders</Trans>
              ) : (
                <Plural value={selected.size} one="# folder picked" other="# folders picked" />
              )}
            </span>
          </span>
          <ChevronsUpDown aria-hidden className="ms-2 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        // Keep focus inside the Command's input rather than bouncing back to
        // the trigger button — Radix's default onOpenAutoFocus on
        // PopoverContent focuses the root, which then forwards to whichever
        // child has tabindex=0. cmdk's <CommandInput> doesn't auto-focus
        // unless we route focus to it explicitly.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
        }}
        // Popover-inside-Dialog: Radix Dialog wraps content in
        // react-remove-scroll, whose document-level wheel/touchmove
        // listeners preventDefault native scroll on portaled descendants
        // (the popover renders to document.body, outside the dialog's
        // DOM tree). stopPropagation here keeps the event from reaching
        // those listeners, so native scroll fires normally.
        // https://github.com/radix-ui/primitives/issues/1159
        onWheel={(e) => {
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
        }}
      >
        {rows.length === 0 ? (
          <p
            className="px-3 py-2 text-sm text-muted-foreground"
            data-testid={`frontmatter-schema-folder-tree-empty-${file}`}
          >
            <Trans>No folders in this project yet.</Trans>
          </p>
        ) : (
          <Command label={pickerLabel}>
            <CommandInput placeholder={t`Search folders`} />
            <CommandList
              id={listboxId}
              aria-multiselectable="true"
              className="subtle-scrollbar"
              data-testid={`frontmatter-schema-folder-tree-${file}`}
            >
              <CommandEmpty>
                <Trans>No folders match.</Trans>
              </CommandEmpty>
              {rows.map((row) => {
                const checked = selected.has(row.path);
                const covered = !checked && coveredByAncestor(row.path, selected);
                const count = counts.get(row.path) ?? 0;
                return (
                  <CommandItem
                    key={row.path}
                    value={row.path}
                    disabled={covered}
                    // Multi-select listbox: checked state rides aria-checked
                    // (cmdk reserves aria-selected for the highlight). A
                    // covered row reads checked — its docs ARE in scope.
                    aria-checked={checked || covered}
                    title={
                      covered
                        ? t`Already covered by a picked parent folder`
                        : t`Toggles the pattern ${row.path}/**`
                    }
                    onSelect={() => onChange(toggleFolderGlob(globs, row.path, !checked))}
                    data-testid={`frontmatter-schema-folder-item-${file}-${row.path}`}
                  >
                    <Check
                      aria-hidden
                      className={cn(
                        'size-4 shrink-0',
                        checked ? 'opacity-100' : covered ? 'opacity-40' : 'opacity-0',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <Plural value={count} one="# doc" other="# docs" />
                    </span>
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
