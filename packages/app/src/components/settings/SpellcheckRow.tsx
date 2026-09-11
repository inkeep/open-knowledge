import { useLingui } from '@lingui/react/macro';
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SavedIndicator } from './field-controls';
import { isOkDesktopHost } from './settings-host-gates';

type SpellcheckReadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly enabled: boolean }
  | { readonly status: 'error' };

export function SpellcheckRow() {
  const { t } = useLingui();
  const labelText = t`Check spelling while typing`;
  const [state, setState] = useState<SpellcheckReadState>({ status: 'loading' });
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
    if (!isOkDesktopHost()) return;
    const menu = window.okDesktop?.menu;
    if (!menu) {
      setState({ status: 'error' });
      return;
    }
    let cancelled = false;
    menu
      .dispatch({ kind: 'query' })
      .then((snapshot) => {
        if (cancelled) return;
        setState(
          snapshot ? { status: 'ready', enabled: snapshot.spellCheckEnabled } : { status: 'error' },
        );
      })
      .catch((error: unknown) => {
        console.warn('[SpellcheckRow] Could not read spell checking state', error);
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isOkDesktopHost()) return null;

  async function requestEnabled(enabled: boolean): Promise<void> {
    const spellcheck = window.okDesktop?.spellcheck;
    if (!spellcheck) return;
    setSavedTick(false);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    setBusy(true);
    try {
      const result = await spellcheck.setEnabled(enabled);
      if (result.ok) {
        setState({ status: 'ready', enabled: result.enabled });
        if (result.saved) {
          setSavedTick(true);
          savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
        } else {
          toast.error(
            result.enabled
              ? t`Spell checking is on, but the change couldn't be saved and won't apply after a restart.`
              : t`Spell checking is off, but the change couldn't be saved and won't apply after a restart.`,
          );
        }
      } else {
        toast.error(t`Couldn't change spell checking. Try again.`);
      }
    } catch (error) {
      console.warn('[SpellcheckRow] Could not change spell checking state', { enabled, error });
      toast.error(t`Couldn't change spell checking. Try again.`);
    }
    setBusy(false);
  }

  return (
    <div
      className="grid gap-2"
      data-field="spellcheck.enabled"
      data-testid="settings-spellcheck-row"
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="settings-spellcheck-toggle" className="font-medium text-sm">
          {labelText}
        </label>
        {state.status === 'ready' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground opacity-60 hover:opacity-100"
                disabled={busy}
                onClick={() => void requestEnabled(true)}
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
        id="settings-spellcheck-toggle-description"
        className="text-1sm text-muted-foreground"
        data-testid="settings-spellcheck-body"
      >
        {state.status === 'loading'
          ? t`Reading the current setting…`
          : state.status === 'error'
            ? t`Couldn't read the spell checking setting.`
            : t`Underlines misspelled words in the editor.`}
      </p>
      {state.status === 'ready' ? (
        <div className="flex items-center gap-2">
          <Switch
            id="settings-spellcheck-toggle"
            aria-describedby="settings-spellcheck-toggle-description"
            aria-label={labelText}
            checked={state.enabled}
            disabled={busy}
            onCheckedChange={(next) => void requestEnabled(next)}
            data-testid="settings-spellcheck-toggle"
          />
          <SavedIndicator visible={savedTick} />
        </div>
      ) : null}
    </div>
  );
}
