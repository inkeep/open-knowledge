/**
 * Card-style light/dark/system picker, shared by first-launch setup and the
 * Settings appearance field.
 *
 * Controlled and persistence-free on purpose: the two call sites commit a
 * choice differently — first-launch writes straight through `next-themes`
 * (localStorage is the canonical cache while `appearance.theme` is unset),
 * while Settings routes through the config field so the value canonicalizes
 * into `config.yml`. Owning either policy here would force one call site to
 * fight it.
 *
 * Built on the Radix radio-group primitive rather than three buttons so the
 * roving tabindex, arrow-key navigation, and `aria-checked` semantics come for
 * free. Rolling those by hand is where card-shaped pickers usually lose their
 * keyboard support.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentType } from 'react';
import { RadioGroup } from '@/components/ui/radio-group';
import { narrowThemePreference, type ThemePreference } from '@/lib/use-apply-config-theme';
import { cn } from '@/lib/utils';

// Re-exported so the picker stays the one import for card call sites, while
// `lib/` consumers take the narrowing straight from its module.
export { narrowThemePreference, type ThemePreference };

/** Which tone(s) an option's thumbnail renders. `split` is the system preview. */
type PreviewTone = 'split' | 'dark' | 'light';

interface ThemeOption {
  value: ThemePreference;
  label: MessageDescriptor;
  Icon: ComponentType<{ className?: string }>;
  preview: PreviewTone;
}

/**
 * Fixed order — system first, since it is the default and the one most users
 * keep, then light before dark so the row runs from lightest to darkest. Every
 * surface that offers the choice renders this one list, so the order stays the
 * same wherever the user meets it. `msg` defers translation to render time,
 * matching how the Settings enum labels are declared.
 */
const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'system', label: msg`System`, Icon: MonitorIcon, preview: 'split' },
  { value: 'light', label: msg`Light`, Icon: SunIcon, preview: 'light' },
  { value: 'dark', label: msg`Dark`, Icon: MoonIcon, preview: 'dark' },
];

export interface ThemePickerProps {
  value: ThemePreference;
  onValueChange: (next: ThemePreference) => void;
  disabled?: boolean;
  /** Accessible name for the group — each call site labels it in its own words. */
  'aria-label': string;
  /**
   * Placed on the first card. The group root renders a <div>, which is not a
   * labelable element, so a settings row's `<label htmlFor>` has to point at a
   * focusable descendant or clicking the label moves focus nowhere.
   */
  firstItemId?: string;
  /**
   * Declared rather than picked up from a rest spread: a caller inside a
   * `<FormControl>` slot hands these down for the group to expose, and a
   * component that only destructures its named props drops anything it does
   * not name. Without them the field description renders but is referenced by
   * nothing, which is the state assistive tech sees as no description at all.
   */
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  className?: string;
}

export function ThemePicker({
  value,
  onValueChange,
  disabled,
  'aria-label': ariaLabel,
  firstItemId,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  className,
}: ThemePickerProps) {
  const { t } = useLingui();
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as ThemePreference)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedby}
      aria-invalid={ariaInvalid}
      // auto-fit rather than a breakpoint: this renders both in a wide dialog
      // and in the narrow Settings field column, so the wrap point has to come
      // from the space the group actually has, not the viewport width.
      className={cn('grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3', className)}
      data-testid="theme-picker"
    >
      {THEME_OPTIONS.map((option, index) => (
        <ThemePickerOption
          key={option.value}
          option={option}
          label={t(option.label)}
          id={index === 0 ? firstItemId : undefined}
        />
      ))}
    </RadioGroup>
  );
}

/**
 * One card. `data-[state=checked]` drives the selected ring + check badge, so
 * selection styling reads off Radix's own state rather than a prop comparison
 * that could drift from what the group actually considers checked.
 */
function ThemePickerOption({
  option,
  label,
  id,
}: {
  option: ThemeOption;
  label: string;
  id?: string;
}) {
  const { Icon, preview, value } = option;
  return (
    <RadioGroupPrimitive.Item
      value={value}
      id={id}
      // The card IS the control, so the shadcn RadioGroupItem circle styling is
      // deliberately not reused here.
      className="group relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card/50 p-2 text-start outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
      data-testid={`theme-picker-${value}`}
    >
      <span className="relative block overflow-hidden rounded-md border border-border/60">
        <ThemePreview tone={preview} />
        {/* Selected badge. Hidden from AT — `aria-checked` on the item already
            carries the state, so announcing a check icon would double it. */}
        <span
          className="absolute end-1.5 top-1.5 hidden size-4 items-center justify-center rounded-full bg-primary text-primary-foreground group-data-[state=checked]:flex"
          aria-hidden
        >
          <CheckIcon className="size-3" />
        </span>
      </span>
      <span className="flex items-center gap-1.5 px-0.5 pb-0.5 font-medium text-1sm text-foreground">
        {/* Decorative: the adjacent text is the option's name, so announcing
            the icon too would read as "Sun icon Light". */}
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

/**
 * Thumbnail of an editor window — sidebar plus content lines. Decorative, so
 * the whole thing is `aria-hidden`; the option's text label is the real name.
 *
 * `split` renders the light mock with the dark mock clipped over its leading
 * half, which keeps one mock definition instead of a third hand-tuned variant.
 */
function ThemePreview({ tone }: { tone: PreviewTone }) {
  if (tone === 'split') {
    return (
      <span className="relative block" aria-hidden>
        <MockWindow tone="light" />
        {/* Fixed 50% clip with the inner mock forced back to the card's full
            width, so the two halves line up instead of the dark side rendering
            its own squeezed layout. */}
        <span className="absolute inset-y-0 start-0 w-1/2 overflow-hidden">
          <span className="block w-[200%]">
            <MockWindow tone="dark" />
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="block" aria-hidden>
      <MockWindow tone={tone} />
    </span>
  );
}

/**
 * Literal hex rather than theme tokens: each mock must depict its own mode
 * regardless of the mode the app is currently in — a `bg-background` light
 * preview would turn dark the moment the user picked dark, and all three cards
 * would look identical.
 */
function MockWindow({ tone }: { tone: 'dark' | 'light' }) {
  const dark = tone === 'dark';
  return (
    <span
      className="flex h-24 w-full gap-1.5 p-1.5"
      style={{ backgroundColor: dark ? '#18181b' : '#ffffff' }}
    >
      <span
        className="flex w-1/3 shrink-0 flex-col gap-1.5 rounded-sm p-1.5"
        style={{ backgroundColor: dark ? '#000000' : '#f4f4f5' }}
      >
        <Bar className="w-3/4" tone={tone} strength="strong" />
        <Bar className="w-full" tone={tone} strength="weak" />
        <Bar className="w-2/3" tone={tone} strength="weak" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <Bar className="w-1/2" tone={tone} strength="strong" />
        <Bar className="w-full" tone={tone} strength="weak" />
        <Bar className="w-5/6" tone={tone} strength="weak" />
      </span>
    </span>
  );
}

function Bar({
  className,
  tone,
  strength,
}: {
  className: string;
  tone: 'dark' | 'light';
  strength: 'strong' | 'weak';
}) {
  const dark = tone === 'dark';
  const color = dark
    ? strength === 'strong'
      ? '#52525b'
      : '#27272a'
    : strength === 'strong'
      ? '#d4d4d8'
      : '#e4e4e7';
  return (
    <span className={cn('block h-1 rounded-full', className)} style={{ backgroundColor: color }} />
  );
}
