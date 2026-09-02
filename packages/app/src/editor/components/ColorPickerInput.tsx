import { useLingui } from '@lingui/react/macro';
import { Eraser } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';

interface ColorPickerInputProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
}

export function nativePickerValue(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/) ?? [];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#000000';
}

export function ColorPickerInput({ id, value, onChange, autoFocus }: ColorPickerInputProps) {
  const { t } = useLingui();
  const nativePickerRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex gap-1">
      <div className="relative flex-1">
        <Input
          id={id}
          type="text"
          value={value}
          placeholder="#F05032 or rgb(240,80,50)"
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          data-prop-autofocus={autoFocus ? '' : undefined}
          className={cn('h-7 text-sm', value ? 'pl-7' : undefined)}
          data-color-picker-input=""
        />
        {value && (
          <span
            style={{ backgroundColor: value }}
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 rounded-sm border border-border"
            aria-hidden="true"
            data-color-picker-swatch=""
          />
        )}
      </div>
      <div className="relative">
        {}
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t`Choose color`}
          data-color-picker-trigger=""
          className="h-7 gap-1 px-2"
          onClick={() => nativePickerRef.current?.click()}
        >
          <span
            style={{ backgroundColor: value || 'transparent' }}
            className="size-3.5 rounded-sm border border-border"
            aria-hidden="true"
          />
        </Button>
        <input
          ref={nativePickerRef}
          type="color"
          value={nativePickerValue(value)}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-7 opacity-0"
          data-color-picker-native=""
        />
      </div>
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={t`Clear color`}
          data-color-picker-clear=""
          className="h-7 px-1.5"
          onClick={() => onChange('')}
        >
          <Eraser className="size-3" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
