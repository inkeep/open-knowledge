import {
  PICKER_LOCALES,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import type { Ref } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SlotForwardedProps } from './slot-forwarded-props';

type LanguageChoice = 'system' | SupportedLocale;

const SYSTEM = 'system';

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function toLanguageChoice(value: unknown): LanguageChoice {
  return isSupportedLocale(value) ? value : SYSTEM;
}

function languageEndonym(locale: SupportedLocale): string {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
}

function ChoiceLabel({ choice }: { choice: LanguageChoice }) {
  if (choice === SYSTEM) return <Trans>System</Trans>;
  return (
    <span lang={choice} className="capitalize">
      {languageEndonym(choice)}
    </span>
  );
}

interface LanguageSelectProps extends SlotForwardedProps {
  value: unknown;
  onValueChange: (next: LanguageChoice) => void;
  onBlur: () => void;
  ref?: Ref<HTMLButtonElement>;
}

export function LanguageSelect({
  value,
  onValueChange,
  onBlur,
  ref,
  ...slotForwarded
}: LanguageSelectProps) {
  const choice = toLanguageChoice(value);
  return (
    <Select value={choice} onValueChange={(next) => onValueChange(toLanguageChoice(next))}>
      {}
      <SelectTrigger {...slotForwarded} ref={ref} onBlur={onBlur} size="sm" className="w-48">
        <SelectValue>
          <ChoiceLabel choice={choice} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SYSTEM}>
          <ChoiceLabel choice={SYSTEM} />
        </SelectItem>
        {PICKER_LOCALES.map((locale) => (
          <SelectItem key={locale} value={locale}>
            <ChoiceLabel choice={locale} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
