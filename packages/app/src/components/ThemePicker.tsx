import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentType } from 'react';
import { RadioGroup } from '@/components/ui/radio-group';
import { narrowThemePreference, type ThemePreference } from '@/lib/use-apply-config-theme';
import { cn } from '@/lib/utils';

export { narrowThemePreference, type ThemePreference };

type PreviewTone = 'split' | 'dark' | 'light';

interface ThemeOption {
  value: ThemePreference;
  label: MessageDescriptor;
  Icon: ComponentType<{ className?: string }>;
  preview: PreviewTone;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'system', label: msg`System`, Icon: MonitorIcon, preview: 'split' },
  { value: 'light', label: msg`Light`, Icon: SunIcon, preview: 'light' },
  { value: 'dark', label: msg`Dark`, Icon: MoonIcon, preview: 'dark' },
];

export interface ThemePickerProps {
  value: ThemePreference;
  onValueChange: (next: ThemePreference) => void;
  disabled?: boolean;
  'aria-label': string;
  firstItemId?: string;
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
      className="group relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card/50 p-2 text-start outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
      data-testid={`theme-picker-${value}`}
    >
      <span className="relative block overflow-hidden rounded-md border border-border/60">
        <ThemePreview tone={preview} />
        {}
        <span
          className="absolute end-1.5 top-1.5 hidden size-4 items-center justify-center rounded-full bg-primary text-primary-foreground group-data-[state=checked]:flex"
          aria-hidden
        >
          <CheckIcon className="size-3" />
        </span>
      </span>
      <span className="flex items-center gap-1.5 px-0.5 pb-0.5 font-medium text-1sm text-foreground">
        {}
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

function ThemePreview({ tone }: { tone: PreviewTone }) {
  if (tone === 'split') {
    return (
      <span className="relative block" aria-hidden>
        <MockWindow tone="light" />
        {}
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
