import { i18n } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '@/components/ui/combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SavedIndicator } from './field-controls';
import { isSpellcheckLanguageSelectionAvailable } from './settings-host-gates';

type LanguagesReadState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly available: readonly string[];
      readonly selected: readonly string[];
      readonly defaults: readonly string[];
    }
  | { readonly status: 'error' };

function languageLabels(codes: readonly string[], locale: string): Map<string, string> {
  const labels = new Map(codes.map((code) => [code, code]));
  let displayNames: Intl.DisplayNames;
  try {
    displayNames = new Intl.DisplayNames([locale || 'en'], { type: 'language' });
  } catch (error) {
    console.warn('[SpellcheckLanguagesRow] Creating language labels failed', { locale, error });
    return labels;
  }
  for (const code of labels.keys()) {
    try {
      labels.set(code, displayNames.of(code) ?? code);
    } catch (error) {
      console.warn('[SpellcheckLanguagesRow] Naming a spelling language failed', {
        locale,
        code,
        error,
      });
    }
  }
  return labels;
}

export function SpellcheckLanguagesRow() {
  const { t } = useLingui();
  const labelText = t`Spelling languages`;
  const labelId = useId();
  const descriptionId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const chipsRef = useComboboxAnchor();
  const [state, setState] = useState<LanguagesReadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const savedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isSpellcheckLanguageSelectionAvailable()) return;
    const spellcheck = window.okDesktop?.spellcheck;
    if (!spellcheck) {
      setState({ status: 'error' });
      return;
    }
    let cancelled = false;
    spellcheck
      .languages()
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? {
                status: 'ready',
                available: result.state.available,
                selected: result.state.selected,
                defaults: result.state.defaults,
              }
            : { status: 'error' },
        );
      })
      .catch((error) => {
        console.warn('[SpellcheckLanguagesRow] Reading spelling languages failed', error);
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isSpellcheckLanguageSelectionAvailable()) return null;

  async function submitSelection(languages: readonly string[]): Promise<void> {
    const spellcheck = window.okDesktop?.spellcheck;
    if (!spellcheck) return;
    setSavedTick(false);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    setBusy(true);
    try {
      const result = await spellcheck.setLanguages(languages);
      if (result.ok) {
        setState({
          status: 'ready',
          available: result.state.available,
          selected: result.state.selected,
          defaults: result.state.defaults,
        });
        setSavedTick(true);
        savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
      } else {
        toast.error(
          result.reason === 'unsupported-language'
            ? t`That language isn't available for spell checking.`
            : t`Couldn't change the spelling languages. Try again.`,
        );
      }
    } catch (error) {
      console.warn('[SpellcheckLanguagesRow] Changing spelling languages failed', {
        languages,
        error,
      });
      toast.error(t`Couldn't change the spelling languages. Try again.`);
    }
    setBusy(false);
  }

  const locale = i18n.locale;
  const labels = languageLabels(
    state.status === 'ready' ? [...state.available, ...state.selected] : [],
    locale,
  );
  const languageLabel = (code: string) => labels.get(code) ?? code;
  const pickerHint =
    state.status === 'loading'
      ? t`Reading the current languages…`
      : state.status === 'error'
        ? t`Couldn't read the spelling languages.`
        : t`New languages may need an internet connection and time to become available.`;

  return (
    <div
      ref={rowRef}
      className="grid min-w-0 grid-cols-1 gap-2"
      data-field="spellcheck.languages"
      data-testid="settings-spellcheck-languages-row"
    >
      <div className="flex items-center justify-between gap-2">
        <p id={labelId} className="font-medium text-sm">
          {labelText}
        </p>
        {state.status === 'ready' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground opacity-60 hover:opacity-100"
                disabled={busy}
                onClick={() => void submitSelection(state.defaults)}
                aria-label={t`Reset ${labelText} to default`}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t`Reset to default`}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <p
        id={descriptionId}
        className="text-1sm text-muted-foreground"
        data-testid="settings-spellcheck-languages-body"
      >
        {pickerHint}
      </p>
      {state.status === 'ready' ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <Combobox
              multiple
              items={state.available}
              value={[...state.selected]}
              readOnly={busy}
              itemToStringLabel={(code) => `${languageLabel(code)} ${code}`}
              onValueChange={(languages, details) => {
                if (busy || languages.length === 0) {
                  details.cancel();
                  return;
                }
                void submitSelection(languages);
              }}
            >
              <ComboboxChips
                ref={chipsRef}
                aria-labelledby={labelId}
                className="min-w-0 flex-1"
                data-testid="settings-spellcheck-languages-trigger"
              >
                <ComboboxValue>
                  {state.selected.map((code) => (
                    <ComboboxChip
                      key={code}
                      className="min-w-0 max-w-full"
                      showRemove={state.selected.length > 1}
                      removeLabel={t`Remove ${languageLabel(code)}`}
                    >
                      <span className="truncate">{languageLabel(code)}</span>
                    </ComboboxChip>
                  ))}
                </ComboboxValue>
                <ComboboxChipsInput
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  placeholder={
                    state.selected.length > 0 ? t`Search languages` : t`Select spelling languages`
                  }
                />
              </ComboboxChips>
              <ComboboxContent
                anchor={chipsRef}
                container={rowRef}
                align="start"
                aria-labelledby={labelId}
                className="w-(--anchor-width) min-w-0 max-w-(--available-width) p-0"
              >
                <ComboboxEmpty
                  data-testid={
                    state.available.length === 0 ? 'settings-spellcheck-languages-empty' : undefined
                  }
                >
                  {state.available.length === 0
                    ? t`No spelling languages are available.`
                    : t`No languages match.`}
                </ComboboxEmpty>
                <ComboboxList
                  className="subtle-scrollbar"
                  data-testid="settings-spellcheck-languages-list"
                >
                  {(code: string) => {
                    const label = languageLabel(code);
                    const checked = state.selected.includes(code);
                    const isLastSelected = checked && state.selected.length === 1;
                    return (
                      <ComboboxItem
                        key={code}
                        value={code}
                        disabled={isLastSelected || busy}
                        data-testid={`settings-spellcheck-language-item-${code}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {code}
                        </span>
                      </ComboboxItem>
                    );
                  }}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <SavedIndicator visible={savedTick} />
          </div>
          <p className="text-1sm text-muted-foreground">
            {t`Existing underlines may not update immediately.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
