/**
 * Color-picker variant of the PropPanel string input — text field on
 * the left with a color swatch trigger on the right. Clicking the
 * trigger opens the browser's native `<input type="color">` picker
 * (OS-level color wheel + recently-used swatches without us shipping a
 * custom palette UI).
 *
 * The underlying value stays a free string — the picker writes a
 * 7-character hex like `#F05032` when an OS color is chosen, but
 * authors can paste any value (CSS color name, `hsl(…)`, `rgb(…)`,
 * `var(--accent)`). Validation lives at the renderer / sanitizer
 * boundary — this input is purely an authoring affordance.
 *
 * Clear semantics: `value === ''` writes `undefined` upstream via the
 * caller's `treatEmptyAsUndefined` handling. A dedicated "Clear" button
 * surfaces when the value is non-empty.
 */
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

/**
 * Resolve a free-string color value to a 7-char hex usable as the
 * native picker's `value` (it only accepts `#RRGGBB`). Returns
 * `'#000000'` as a safe fallback for non-hex strings — the picker
 * still works as an authoring affordance, but the swatch defaults to
 * black instead of mirroring an unknown value.
 *
 * Pure — exported for tests.
 */
export function nativePickerValue(value: string): string {
  const trimmed = value.trim();
  // Browser's `<input type="color">` only honors 7-char `#RRGGBB`.
  // Short-form `#RGB` expands to `#RRGGBB` for the picker's initial
  // value but the picker itself only emits the long form.
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/) ?? [];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#000000';
}

export function ColorPickerInput({ id, value, onChange, autoFocus }: ColorPickerInputProps) {
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
            // Live preview swatch inset into the text field. Uses inline
            // style because the color value is dynamic — Tailwind can't
            // express arbitrary user-provided hex without `data-style`
            // gymnastics, and the swatch is the picker's primary visual
            // affordance.
            style={{ backgroundColor: value }}
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 rounded-sm border border-border"
            aria-hidden="true"
            data-color-picker-swatch=""
          />
        )}
      </div>
      <div className="relative">
        {/*
          Native `<input type="color">` is positioned absolute over the
          visible Button — the click on the Button passes through to the
          input which opens the OS picker. We hide the native widget
          (opacity-0) rather than `display: none` because the OS only
          honors clicks on visible elements.
        */}
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label="Choose color"
          data-color-picker-trigger=""
          className="h-7 gap-1 px-2"
          onClick={() => nativePickerRef.current?.click()}
        >
          <span
            // Bigger swatch on the trigger so the chosen color is
            // recognizable at a glance.
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
          aria-label="Clear color"
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
