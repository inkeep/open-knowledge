/**
 * The interface-language picker for Settings → Preferences.
 *
 * Offers `PICKER_LOCALES` plus the `'system'` sentinel — deliberately narrower
 * than the config enum, which admits every enumerated locale. Promoting a
 * locale is therefore a one-line change in core, not an edit here.
 *
 * The sentinel is written through unresolved. Resolving `'system'` to a concrete
 * tag at the click site would freeze the preference at whatever the OS said
 * once, which is the same hazard `no-resolved-value-theme-source.grit` guards
 * for theme.
 *
 * Each language is named in its own language, so someone who cannot read the
 * language currently on screen can still find theirs. CLDR supplies the name and
 * `lang` tells assistive tech which language to pronounce it in.
 */

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

/** What the picker holds: an enumerated locale, or "follow the OS". */
type LanguageChoice = 'system' | SupportedLocale;

const SYSTEM = 'system';

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Narrow the form's `unknown`-typed value. Unset reads as `'system'`, matching
 * how the resolver treats an absent preference.
 */
function toLanguageChoice(value: unknown): LanguageChoice {
  return isSupportedLocale(value) ? value : SYSTEM;
}

/**
 * A locale's name in that locale. `Intl.DisplayNames` falls back to the tag
 * itself for a name CLDR has no entry for, and the `??` covers the `fallback:
 * 'none'` shape TypeScript types this as returning.
 */
function languageEndonym(locale: SupportedLocale): string {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
}

function ChoiceLabel({ choice }: { choice: LanguageChoice }) {
  if (choice === SYSTEM) return <Trans>System</Trans>;
  // `capitalize` because CLDR spells names the way the language writes them
  // mid-sentence ("español"), and a list entry sits in title position.
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
      {/*
        The trigger renders the label itself rather than letting Radix mirror the
        selected item's text. A preference naming a locale that is enumerated but
        not yet in the picker has no item to mirror, and would otherwise show as
        an empty control.
      */}
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
