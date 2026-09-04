import { Trans, useLingui } from '@lingui/react/macro';
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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
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
            aria-label={t`Choose icon`}
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
          className="z-70 w-72 p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command label={t`Icon picker`}>
            <CommandInput placeholder={t`Search icons...`} className="h-8 text-sm" />
            <CommandList className="max-h-64">
              <CommandEmpty>
                <Trans>No icons match.</Trans>
              </CommandEmpty>
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
                {}
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
