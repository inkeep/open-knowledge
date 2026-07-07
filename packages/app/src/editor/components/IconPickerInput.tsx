/**
 * Icon-picker variant of the PropPanel string input — text field on the
 * left with a popover trigger on the right that opens a searchable grid
 * of allowlisted lucide icons.
 *
 * Why a picker (not a plain text input):
 *   - Authors need to know which `lucide:<Name>` identifiers actually
 *     resolve. The renderer's allowlist (`LUCIDE_ICON_ALLOWLIST`) is
 *     curated, so freeform text input lets authors type names that
 *     silently fall back to the type's default icon.
 *   - The picker grid + name search makes valid choices discoverable
 *     without leaving the editor.
 *
 * The underlying value is still a free string — the picker writes
 * `lucide:<Name>` when an icon is chosen, but authors can paste an
 * emoji or any other string and the field accepts it. The renderer
 * decides what to do with non-allowlist values (Callout falls back to
 * the type default; Accordion to the chevron).
 *
 * Mount: `<IconPickerInput id value onChange autoFocus />`.
 * Selection: clicking an icon writes `lucide:<Name>` and closes the
 * popover. The "Clear" item writes an empty string (treated by the
 * PropPanel's `treatEmptyAsUndefined` logic as a delete signal for
 * optional props).
 */
import { Command as CommandPrimitive } from 'cmdk';
import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../components/ui/command';
import { Input } from '../../components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { cn } from '../../lib/utils';
import { LUCIDE_ICON_ENTRIES, resolveLucideIcon } from './lucide-icon-allowlist.ts';

interface IconPickerInputProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
}

export function IconPickerInput({ id, value, onChange, autoFocus }: IconPickerInputProps) {
  const [open, setOpen] = useState(false);
  // The text field is always the source of truth — the picker just
  // writes into it. Live-resolve the current value to a lucide icon for
  // the trigger preview (rendered as a small inset chip).
  const PreviewIcon = resolveLucideIcon(value);
  const selectedName = value.startsWith('lucide:') ? value.slice('lucide:'.length) : null;

  return (
    <div className="flex gap-1">
      <div className="relative flex-1">
        <Input
          id={id}
          type="text"
          value={value}
          placeholder="lucide:Lightbulb or 📘"
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          data-prop-autofocus={autoFocus ? '' : undefined}
          className={cn('h-7 text-sm', PreviewIcon ? 'pl-7' : undefined)}
          data-icon-picker-input=""
        />
        {PreviewIcon && (
          <PreviewIcon
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label="Choose icon"
            aria-haspopup="listbox"
            aria-expanded={open}
            data-icon-picker-trigger=""
            className="h-7 gap-1 px-2"
          >
            <ChevronDown className="size-3" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          // PropPanel renders inside a z-[60] PopoverContent (see
          // JsxComponentView.tsx + the matching note on the enum Select
          // in PropPanel.tsx); both portal to body, so the picker's
          // default z-50 would paint BEHIND the PropPanel. Bump above.
          className="z-70 w-72 p-0"
          // Keep focus on the text input rather than stealing it on open;
          // cmdk's CommandInput inside the popover takes focus when the
          // user actually starts typing into it.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command label="Icon picker">
            <CommandInput placeholder="Search icons..." className="h-8 text-sm" />
            <CommandList className="max-h-64">
              <CommandEmpty>No icons match.</CommandEmpty>
              {value.length > 0 && (
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={() => {
                      onChange('');
                      setOpen(false);
                    }}
                    className="gap-2 text-muted-foreground"
                    data-icon-picker-clear=""
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    Clear icon
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Lucide">
                {/*
                  The grid layout is applied to the CommandPrimitive.Group's
                  inner `[cmdk-group-items]` slot — Tailwind targets the
                  data-slot attribute via the parent. We use grid-cols-6 so
                  the 16-icon allowlist fits in ~3 rows with comfortable
                  tap targets, and the trigger's `aria-haspopup="listbox"`
                  is honored by cmdk's keyboard navigation.
                */}
                <CommandPrimitive.Group className="[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-6 [&_[cmdk-group-items]]:gap-1 [&_[cmdk-group-items]]:p-1">
                  {LUCIDE_ICON_ENTRIES.map(([name, Icon]) => {
                    const isSelected = name === selectedName;
                    return (
                      <CommandItem
                        key={name}
                        value={name}
                        onSelect={() => {
                          onChange(`lucide:${name}`);
                          setOpen(false);
                        }}
                        title={name}
                        aria-label={name}
                        data-icon-picker-item={name}
                        data-icon-picker-selected={isSelected ? '' : undefined}
                        className={cn(
                          'flex aspect-square items-center justify-center rounded-md p-0',
                          isSelected
                            ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/30'
                            : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        <Icon className="size-4" aria-hidden="true" />
                      </CommandItem>
                    );
                  })}
                </CommandPrimitive.Group>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
