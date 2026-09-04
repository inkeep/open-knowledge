// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  type Base16ParseError,
  type Base16Scheme,
  type Base16Slot,
  base16ToYaml,
  type ConfigBinding,
  parseBase16Scheme,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ClipboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  base16ToTokens,
  customThemeKind,
  customThemeWritePatch,
  DEFAULT_CUSTOM_SCHEME,
  hasLegacyCustomSeed,
  isHexColor,
  resolveColorThemeSelection,
  resolveCustomScheme,
  resolveModePreference,
} from '@/lib/color-themes';
import { useConfigContextOptional } from '@/lib/config-context';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { useSavedThemes } from '@/lib/saved-themes-client';
import { applyColorThemeToDom } from '@/lib/use-apply-config-color-theme';
import { cn } from '@/lib/utils';
import { ThemePreviewCanvas } from './ThemePreviewCanvas';

const SCHEMES_URL = 'https://github.com/tinted-theming/schemes';

export function CustomThemeEditor({ userBinding }: { userBinding: ConfigBinding }) {
  const { t } = useLingui();
  const {
    themes,
    refresh: refreshSavedThemes,
    updateTheme,
    editingThemeId,
    themeIncarnations,
    selectThemeToEdit,
  } = useSavedThemes();
  const { setTheme, systemTheme } = useTheme();
  const merged = useConfigContextOptional()?.merged ?? null;
  const savedTheme =
    editingThemeId === 'custom' ? undefined : themes.find((theme) => theme.id === editingThemeId);
  const isEditingSavedTheme = savedTheme?.scheme !== undefined;
  const workbenchScheme = resolveCustomScheme(merged?.appearance?.customTheme);
  const committed = savedTheme?.scheme ?? workbenchScheme;
  const themeIncarnation = themeIncarnations[editingThemeId] ?? 0;
  const editorStateKey = `${editingThemeId}:${themeIncarnation}`;
  const modePreference = merged?.appearance?.theme;
  const selection = resolveColorThemeSelection(merged?.appearance, themes);
  const slotMode = resolveModePreference(modePreference, systemTheme === 'dark');
  const isActive = selection[slotMode] === editingThemeId;
  const applicationStateRef = useRef({
    editorStateKey,
    selection,
    modePreference,
    slotMode,
    customSeed: merged?.appearance?.customTheme,
    themes,
    committed,
  });
  useLayoutEffect(() => {
    applicationStateRef.current = {
      editorStateKey,
      selection,
      modePreference,
      slotMode,
      customSeed: merged?.appearance?.customTheme,
      themes,
      committed,
    };
  });

  const [scheme, setScheme] = useState<Base16Scheme>(committed);
  const draftsRef = useRef<Record<string, Base16Scheme>>({});
  const themeIncarnationsRef = useRef(themeIncarnations);
  useLayoutEffect(() => {
    themeIncarnationsRef.current = themeIncarnations;
  }, [themeIncarnations]);
  const editorStateKeyRef = useRef(editorStateKey);
  useLayoutEffect(() => {
    editorStateKeyRef.current = editorStateKey;
  }, [editorStateKey]);
  const pendingCountsRef = useRef<Record<string, number>>({});
  const revisionsRef = useRef<Record<string, number>>({});
  const latestOutcomesRef = useRef<Record<string, boolean>>({});
  const committedKey = `${editorStateKey}:${JSON.stringify(committed)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: committedKey is the value-stable proxy for `committed`.
  useEffect(() => {
    setScheme(draftsRef.current[editorStateKey] ?? committed);
  }, [committedKey]);

  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteAnnouncement, setPasteAnnouncement] = useState('');
  const [autoSaveStatuses, setAutoSaveStatuses] = useState<
    Record<string, 'saving' | 'saved' | 'problem'>
  >({});
  const autoSaveStatus = autoSaveStatuses[editorStateKey] ?? 'idle';
  const [hoveredSlot, setHoveredSlot] = useState<Base16Slot | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Base16Slot>('base00');
  const needsLegacyMigration = hasLegacyCustomSeed(merged?.appearance?.customTheme);

  function setWorkingScheme(next: Base16Scheme) {
    if (isEditingSavedTheme) draftsRef.current[editorStateKey] = next;
    setScheme(next);
  }

  function preview(next: Base16Scheme) {
    if (!isActive) return;
    const previewThemes = isEditingSavedTheme
      ? themes.map((theme) =>
          theme.id === editingThemeId
            ? {
                ...theme,
                kind: next.variant,
                scheme: next,
                toTokens: () => base16ToTokens(next),
              }
            : theme,
        )
      : themes;
    applyColorThemeToDom({
      selection,
      modePreference,
      slotMode,
      customSeed: isEditingSavedTheme
        ? merged?.appearance?.customTheme
        : customThemeWritePatch(next),
      themes: previewThemes,
    });
    setTheme(customThemeKind(next) === 'dark' ? 'dark' : 'light');
  }

  function persistSavedTheme(next: Base16Scheme) {
    if (!isEditingSavedTheme) return;
    const id = editingThemeId;
    const incarnation = themeIncarnation;
    const lifecycleKey = editorStateKey;
    draftsRef.current[lifecycleKey] = next;
    const revision = (revisionsRef.current[lifecycleKey] ?? 0) + 1;
    revisionsRef.current[lifecycleKey] = revision;
    pendingCountsRef.current[lifecycleKey] = (pendingCountsRef.current[lifecycleKey] ?? 0) + 1;
    setAutoSaveStatuses((current) => ({ ...current, [lifecycleKey]: 'saving' }));
    void updateTheme({ id, scheme: next }).then((result) => {
      const discardDeletedLifecycle = () => {
        delete draftsRef.current[lifecycleKey];
        delete pendingCountsRef.current[lifecycleKey];
        delete revisionsRef.current[lifecycleKey];
        delete latestOutcomesRef.current[lifecycleKey];
        setAutoSaveStatuses((current) => {
          const nextStatuses = { ...current };
          delete nextStatuses[lifecycleKey];
          return nextStatuses;
        });
      };
      if ((themeIncarnationsRef.current[id] ?? 0) !== incarnation) {
        discardDeletedLifecycle();
        return;
      }
      if (revision === revisionsRef.current[lifecycleKey]) {
        latestOutcomesRef.current[lifecycleKey] = result.ok;
        if (result.ok) void refreshSavedThemes();
      }
      const remaining = Math.max(0, (pendingCountsRef.current[lifecycleKey] ?? 1) - 1);
      pendingCountsRef.current[lifecycleKey] = remaining;
      if (remaining === 0) {
        const saved = latestOutcomesRef.current[lifecycleKey] === true;
        const savedCurrentDraft = saved && draftsRef.current[lifecycleKey] === next;
        if (savedCurrentDraft) {
          delete draftsRef.current[lifecycleKey];
          if (editorStateKeyRef.current === lifecycleKey) setScheme(next);
        } else if (!saved) {
          const current = applicationStateRef.current;
          if (
            current.editorStateKey === lifecycleKey &&
            current.selection[current.slotMode] === id
          ) {
            applyColorThemeToDom({
              selection: current.selection,
              modePreference: current.modePreference,
              slotMode: current.slotMode,
              customSeed: current.customSeed,
              themes: current.themes,
            });
            setTheme(customThemeKind(current.committed) === 'dark' ? 'dark' : 'light');
          }
        }
        setAutoSaveStatuses((current) => {
          const nextStatuses = { ...current };
          if (saved && !savedCurrentDraft) delete nextStatuses[lifecycleKey];
          else nextStatuses[lifecycleKey] = savedCurrentDraft ? 'saved' : 'problem';
          return nextStatuses;
        });
      }
    });
  }

  function onPick(slot: Base16Slot, value: string) {
    const next = { ...scheme, palette: { ...scheme.palette, [slot]: value } };
    setWorkingScheme(next);
    if (isHexColor(value)) preview(next);
  }

  function commit(slot: Base16Slot, value: string) {
    if (!isHexColor(value)) return;
    if (isEditingSavedTheme) {
      persistSavedTheme({ ...scheme, palette: { ...scheme.palette, [slot]: value } });
      return;
    }
    if (needsLegacyMigration) {
      const next = { ...scheme, palette: { ...scheme.palette, [slot]: value } };
      userBinding.patch({ appearance: { customTheme: customThemeWritePatch(next) } });
      return;
    }
    userBinding.patch({ appearance: { customTheme: { [slot]: value } } });
  }

  function importThemeText(value: string) {
    const result = parseBase16Scheme(value);
    if (!result.ok) {
      setPasteError(describeParseError(result.error, t));
      setPasteAnnouncement('');
      return false;
    }
    setPasteError(null);
    setPaste('');
    setPasteAnnouncement(t`Theme imported.`);
    setWorkingScheme(result.scheme);
    preview(result.scheme);
    if (isEditingSavedTheme) {
      persistSavedTheme(result.scheme);
      return true;
    }
    userBinding.patch({ appearance: { customTheme: customThemeWritePatch(result.scheme) } });
    return true;
  }

  function pasteTheme(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedText = event.clipboardData.getData('text/plain');
    if (!pastedText) return;
    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const nextValue = `${target.value.slice(0, start)}${pastedText}${target.value.slice(end)}`;
    setPaste(nextValue);
    setPasteAnnouncement('');
    importThemeText(nextValue);
  }

  async function exportYaml() {
    const yaml = base16ToYaml(scheme);
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (write) {
      try {
        await write(yaml);
        toast.success(t`Theme copied as base16 YAML`);
        return;
      } catch {}
    }
    setPaste(yaml);
    setPasteError(null);
    toast.error(t`Couldn’t reach the clipboard — the theme is in the box below.`);
  }

  async function copySelectedColor() {
    const value = scheme.palette[selectedSlot];
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) {
      toast.error(t`Couldn’t reach the clipboard.`);
      return;
    }
    try {
      await write(value);
      toast.success(t`Copied ${selectedSlot}`);
    } catch {
      toast.error(t`Couldn’t reach the clipboard.`);
    }
  }

  function reset() {
    const next = isEditingSavedTheme
      ? {
          ...DEFAULT_CUSTOM_SCHEME,
          name: scheme.name,
          ...(scheme.author ? { author: scheme.author } : {}),
        }
      : DEFAULT_CUSTOM_SCHEME;
    setWorkingScheme(next);
    setPasteError(null);
    preview(next);
    if (isEditingSavedTheme) {
      persistSavedTheme(next);
      return;
    }
    userBinding.patch({
      appearance: { customTheme: customThemeWritePatch(DEFAULT_CUSTOM_SCHEME) },
    });
  }

  return (
    <section
      aria-labelledby="settings-custom-theme-title"
      className="space-y-3"
      data-section="custom-theme"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="settings-custom-theme-title" className="font-medium text-sm">
            {isEditingSavedTheme ? t`Editing ${scheme.name}` : t`Custom theme`}
          </h3>
          <p className="text-1sm text-muted-foreground">
            {isEditingSavedTheme
              ? isActive
                ? t`Edits apply live and save automatically to this theme.`
                : t`Changes save automatically to this theme.`
              : isActive
                ? t`Edits apply live. Light or dark comes from the theme.`
                : t`Press the sun or moon on “Custom” above to use this theme.`}
          </p>
          {isEditingSavedTheme ? (
            <p
              role="status"
              aria-live="polite"
              className={cn(
                'text-xs text-muted-foreground',
                autoSaveStatus === 'problem' && 'text-destructive',
              )}
            >
              {autoSaveStatus === 'saving'
                ? t`Saving changes…`
                : autoSaveStatus === 'saved'
                  ? t`Changes saved automatically.`
                  : autoSaveStatus === 'problem'
                    ? t`Couldn’t save changes. Try editing a color again.`
                    : t`Changes save automatically.`}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={exportYaml}>
            {t`Copy as YAML`}
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
            {t`Reset`}
          </Button>
          {isEditingSavedTheme ? (
            <Button size="sm" onClick={() => selectThemeToEdit(null)}>
              {t`Done`}
            </Button>
          ) : null}
        </div>
      </div>

      {}
      <ThemePreviewCanvas scheme={scheme} highlightSlot={hoveredSlot} className="w-full" />

      <ColorWorkbench
        scheme={scheme}
        selectedSlot={selectedSlot}
        onSelectSlot={setSelectedSlot}
        onPick={onPick}
        commit={commit}
        onSlotFocus={setHoveredSlot}
        onCopy={copySelectedColor}
        colorsLabel={t`Theme colors`}
        selectLabel={(slot) => t`Select ${slot} — ${BASE16_SLOT_ROLES[slot]}`}
        colorLabel={(slot) => t`${slot} color — ${BASE16_SLOT_ROLES[slot]}`}
        hexLabel={(slot) => t`${slot} hex value`}
        copyLabel={t`Copy`}
        invalidHint={t`Enter a 6-digit hex like #1A2B3C`}
      />

      <div className="space-y-1.5 border-t pt-3">
        <Label htmlFor="custom-theme-import" className="text-1sm text-muted-foreground">
          {t`Paste a base16 theme`}
        </Label>
        <Textarea
          id="custom-theme-import"
          value={paste}
          spellCheck={false}
          rows={3}
          placeholder={
            'system: "base16"\nname: "Ayu Dark"\nvariant: "dark"\npalette:\n  base00: "#0f1419"\n  base01: "#131721"'
          }
          aria-invalid={pasteError !== null}
          aria-describedby={
            pasteError
              ? 'custom-theme-import-help custom-theme-import-error'
              : 'custom-theme-import-help'
          }
          onPaste={pasteTheme}
          onBlur={() => {
            if (paste.trim()) importThemeText(paste);
          }}
          onChange={(e) => {
            setPaste(e.target.value);
            setPasteAnnouncement('');
            if (pasteError) setPasteError(null);
          }}
          className="font-mono text-1sm"
          data-testid="custom-theme-import"
        />
        {pasteError ? (
          <FieldError id="custom-theme-import-error" data-testid="custom-theme-import-error">
            {pasteError}
          </FieldError>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span id="custom-theme-import-help" className="text-xs text-muted-foreground">
            {t`YAML or JSON, in either base16 layout.`}{' '}
            <a
              href={SCHEMES_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => dispatchExternalLinkClick(e, SCHEMES_URL)}
              onAuxClick={(e) => dispatchExternalLinkClick(e, SCHEMES_URL)}
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
            >
              {t`Browse hundreds of themes`}
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          </span>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {pasteAnnouncement}
        </span>
      </div>
    </section>
  );
}

function ColorWorkbench({
  scheme,
  selectedSlot,
  onSelectSlot,
  onPick,
  commit,
  colorsLabel,
  selectLabel,
  colorLabel,
  hexLabel,
  copyLabel,
  invalidHint,
  onSlotFocus,
  onCopy,
}: {
  scheme: Base16Scheme;
  selectedSlot: Base16Slot;
  onSelectSlot: (slot: Base16Slot) => void;
  onPick: (slot: Base16Slot, value: string) => void;
  commit: (slot: Base16Slot, value: string) => void;
  colorsLabel: string;
  selectLabel: (slot: Base16Slot) => string;
  colorLabel: (slot: Base16Slot) => string;
  hexLabel: (slot: Base16Slot) => string;
  copyLabel: string;
  invalidHint: string;
  onSlotFocus: (slot: Base16Slot | null) => void;
  onCopy: () => void;
}) {
  const value = scheme.palette[selectedSlot];
  const valid = isHexColor(value);
  const spotlight = {
    onMouseEnter: () => onSlotFocus(selectedSlot),
    onMouseLeave: () => onSlotFocus(null),
    onFocus: () => onSlotFocus(selectedSlot),
  };

  return (
    <div className="space-y-3">
      <fieldset
        aria-label={colorsLabel}
        className="grid min-w-0 grid-cols-4 gap-2 border-0 p-0 md:grid-cols-8"
      >
        {BASE16_SLOTS.map((slot) => {
          const slotValue = scheme.palette[slot];
          const slotValid = isHexColor(slotValue);
          const selected = slot === selectedSlot;
          return (
            <Button
              key={slot}
              type="button"
              variant="ghost"
              aria-label={selectLabel(slot)}
              aria-pressed={selected}
              onClick={() => onSelectSlot(slot)}
              onMouseEnter={() => onSlotFocus(slot)}
              onMouseLeave={() => onSlotFocus(null)}
              onFocus={() => onSlotFocus(slot)}
              onBlur={() => onSlotFocus(null)}
              className="h-auto min-w-0 flex-col gap-1.5 rounded-md p-1 text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              <span
                aria-hidden
                className={cn(
                  'aspect-[4/3] w-full rounded-lg border border-border/70 shadow-sm transition-[box-shadow,border-color,transform]',
                  selected &&
                    'border-foreground ring-2 ring-foreground ring-offset-2 ring-offset-background',
                  !slotValid && 'border-destructive bg-destructive/10',
                )}
                style={{ backgroundColor: slotValid ? slotValue : undefined }}
              />
              <span aria-hidden className="font-mono text-xs uppercase">
                {slot.slice(4)}
              </span>
              <span className="sr-only">{BASE16_SLOT_ROLES[slot]}</span>
            </Button>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center">
        <Input
          type="color"
          aria-label={colorLabel(selectedSlot)}
          value={valid ? value : '#000000'}
          onChange={(event) => onPick(selectedSlot, event.target.value)}
          onBlur={(event) => {
            onSlotFocus(null);
            commit(selectedSlot, event.target.value);
          }}
          {...spotlight}
          className="h-16 w-24 shrink-0 cursor-pointer rounded-lg p-1"
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={`custom-theme-hex-${selectedSlot}`} className="block">
            <span className="font-mono text-base">{selectedSlot}</span>
            <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
              {BASE16_SLOT_ROLES[selectedSlot]}
            </span>
          </Label>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <Input
            id={`custom-theme-hex-${selectedSlot}`}
            value={value}
            spellCheck={false}
            aria-label={hexLabel(selectedSlot)}
            aria-invalid={!valid}
            aria-describedby={!valid ? `custom-theme-hex-error-${selectedSlot}` : undefined}
            onChange={(event) => onPick(selectedSlot, event.target.value)}
            onBlur={(event) => {
              onSlotFocus(null);
              commit(selectedSlot, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(selectedSlot, (event.target as HTMLInputElement).value);
              }
            }}
            {...spotlight}
            className="w-28 font-mono uppercase"
          />
          <Button type="button" variant="outline" onClick={onCopy} disabled={!valid}>
            {copyLabel}
          </Button>
          {!valid ? (
            <FieldError
              id={`custom-theme-hex-error-${selectedSlot}`}
              className="absolute top-full right-0 mt-1 whitespace-nowrap text-xs leading-tight"
              data-testid={`custom-theme-hex-error-${selectedSlot}`}
            >
              {invalidHint}
            </FieldError>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useLingui>['t'];

function describeParseError(error: Base16ParseError, t: Translate): string {
  switch (error.kind) {
    case 'unparseable':
      return error.line === undefined
        ? t`That doesn’t parse as YAML or JSON.`
        : t`That doesn’t parse as YAML or JSON — check line ${error.line}.`;
    case 'not-a-scheme':
      return t`That parsed, but it isn’t a base16 theme.`;
    case 'missing-slots':
      return t`Missing ${error.slots.length} slot(s): ${error.slots.join(', ')}`;
    case 'bad-hex':
      return t`Not a hex color: ${error.slots.join(', ')}`;
  }
}
