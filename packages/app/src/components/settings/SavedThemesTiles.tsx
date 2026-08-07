import { deriveSavedThemeName, parseSavedThemeId } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { TriangleAlert } from 'lucide-react';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  base16ToTokens,
  type ColorTheme,
  type ColorThemeSelection,
  type ColorThemeSelectionInput,
  resolveColorThemeSelection,
  resolveCustomScheme,
} from '@/lib/color-themes';
import { useSavedThemes } from '@/lib/saved-themes-client';
import { ColorThemePicker, type ColorThemePickerProps } from './ColorThemePicker';

interface SavedThemesTilesProps
  extends Omit<ColorThemePickerProps, 'themes' | 'unavailableThemes' | 'selection' | 'onAssign'> {
  appearance: ColorThemeSelectionInput | undefined;
  onAssign: (
    slot: 'light' | 'dark',
    id: string,
    selection: ColorThemeSelection,
    themes: readonly ColorTheme[],
  ) => void;
}

const DELETE_UNDO_DURATION_MS = 12_000;

export function SavedThemesTiles({ appearance, onAssign, ...pickerProps }: SavedThemesTilesProps) {
  const { t } = useLingui();
  const {
    themes,
    warnings,
    truncated,
    loadError,
    refresh,
    deleteTheme,
    restoreTheme: restoreSavedTheme,
    editingThemeId,
    themeEditorOpen,
    selectThemeToEdit,
  } = useSavedThemes();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const createNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selection = resolveColorThemeSelection(appearance, themes);
  const createIdentity = deriveSavedThemeName(createName);
  const galleryThemes = themes.filter((theme) => theme.id !== 'custom');
  const deletableThemes = themes.flatMap((theme) => {
    const parsed = parseSavedThemeId(theme.id);
    if (!parsed.ok || !theme.scheme) return [];
    return [{ id: theme.id, stem: parsed.stem, label: theme.label, scheme: theme.scheme }];
  });

  async function restoreTheme(theme: (typeof deletableThemes)[number] & { filename: string }) {
    const result = await restoreSavedTheme({
      id: theme.id,
      name: theme.scheme.name,
      stem: theme.stem,
      scheme: { ...theme.scheme, palette: { ...theme.scheme.palette } },
      extension: theme.filename.endsWith('.yml') ? '.yml' : '.yaml',
    });
    if (result.ok) {
      await refresh();
      toast.success(t`Restored ${theme.label}.`);
      return;
    }
    if (result.reason === 'name-taken') {
      toast.error(t`Couldn’t restore ${theme.label}. That name is already in use.`);
      return;
    }
    toast.error(t`Couldn’t restore ${theme.label}. Try again.`);
  }

  async function removeTheme(id: string): Promise<boolean> {
    const theme = deletableThemes.find((candidate) => candidate.id === id);
    if (!theme) {
      toast.error(t`Couldn’t delete this theme. Refresh and try again.`);
      return false;
    }

    const result = await deleteTheme(theme.id);
    if (!result.ok) {
      toast.error(t`Couldn’t delete ${theme.label}. Try again.`);
      return false;
    }

    if (editingThemeId === theme.id) selectThemeToEdit(null);
    await refresh();
    if (!result.existed) {
      toast(t`${theme.label} was already deleted.`);
      return true;
    }
    const deletedTheme = {
      ...theme,
      filename: result.filename,
      label: result.scheme.name,
      scheme: result.scheme,
    };
    toast(t`Deleted ${deletedTheme.label}.`, {
      duration: DELETE_UNDO_DURATION_MS,
      action: {
        label: t`Undo`,
        onClick: () => restoreTheme(deletedTheme),
      },
    });
    return true;
  }

  async function createTheme(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (isCreating) return;

    const derived = deriveSavedThemeName(createName);
    if (!derived.ok) {
      setCreateError(t`Enter a name for this theme.`);
      createNameRef.current?.focus();
      return;
    }

    const activeSlot = pickerProps.slotMode ?? 'light';
    const activeTheme = themes.find((theme) => theme.id === selection[activeSlot]);
    const seed = activeTheme?.scheme ?? resolveCustomScheme(pickerProps.customSeed);
    const scheme = {
      name: derived.name,
      variant: seed.variant,
      palette: { ...seed.palette },
    };

    setCreateError(null);
    setIsCreating(true);
    const result = await restoreSavedTheme({
      id: derived.id,
      name: derived.name,
      scheme,
    });
    if (!result.ok) {
      setCreateError(
        result.reason === 'name-taken'
          ? t`A saved theme already uses this name.`
          : result.reason === 'name-invalid'
            ? t`Enter a valid theme name.`
            : t`Couldn’t create this theme. Try again.`,
      );
      setIsCreating(false);
      createNameRef.current?.focus();
      return;
    }

    const createdTheme: ColorTheme = {
      id: result.id,
      label: scheme.name,
      kind: scheme.variant,
      scheme,
      toTokens: () => base16ToTokens(scheme),
    };
    onAssign(activeSlot, result.id, selection, [...themes, createdTheme]);
    await refresh();
    setCreateName('');
    setCreateOpen(false);
    setIsCreating(false);
    selectThemeToEdit(result.id);
  }

  const unavailableThemes = warnings.map((warning) => {
    let problem: string;
    switch (warning.code) {
      case 'unparseable':
        problem = t`Invalid YAML`;
        break;
      case 'not-a-scheme':
        problem = t`Not a base16 theme`;
        break;
      case 'missing-slots':
        problem = t`Missing palette colors`;
        break;
      case 'bad-hex':
        problem = t`Invalid color value`;
        break;
      case 'empty':
        problem = t`Missing theme name`;
        break;
      case 'too-long':
        problem = t`Theme name is too long`;
        break;
      case 'invalid-chars':
        problem = t`Theme name has unsupported characters`;
        break;
      case 'unsupported-extension-case':
        problem = t`Use a lowercase .yaml or .yml extension`;
        break;
      case 'duplicate-identity':
        problem = t`Multiple files use this theme name`;
        break;
      case 'symlink':
        problem = t`Linked theme files aren’t supported`;
        break;
      case 'not-regular-file':
        problem = t`This isn’t a regular theme file`;
        break;
      case 'file-too-large':
        problem = t`This theme file is too large`;
        break;
      case 'read-failed':
        problem = t`This theme file couldn’t be read`;
        break;
      default:
        problem = t`Couldn’t read this theme (${warning.code})`;
    }
    return {
      key: warning.filename,
      label: warning.filename,
      problem,
      detail: warning.conflictingFilenames
        ? t`Conflicting files: ${warning.conflictingFilenames.join(', ')}.`
        : t`This theme can’t be used until the file is fixed.`,
    };
  });
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground"
        >
          <span>{t`Saved themes couldn’t load. The last available theme list is still shown.`}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void refresh()}>
            {t`Try again`}
          </Button>
        </div>
      ) : null}
      <div role="status">
        {truncated ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-foreground">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>{t`Some saved themes aren’t shown because the theme folder exceeds the scan limit.`}</span>
          </div>
        ) : null}
      </div>
      <ColorThemePicker
        {...pickerProps}
        selection={selection}
        themes={galleryThemes}
        unavailableThemes={unavailableThemes}
        editControl={{
          themeIds: themes
            .filter((theme) => theme.id.startsWith('saved-'))
            .map((theme) => theme.id),
          selectedId: themeEditorOpen ? editingThemeId : null,
          onSelect: selectThemeToEdit,
        }}
        deleteControl={{
          themeIds: deletableThemes.map((theme) => theme.id),
          onDelete: removeTheme,
        }}
        createControl={{ onCreate: () => setCreateOpen(true) }}
        onAssign={(slot, id) => onAssign(slot, id, selection, themes)}
      />
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!isCreating) setCreateOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader className="gap-2">
            <DialogTitle>{t`Name your theme`}</DialogTitle>
            <DialogDescription>{t`Give it a name before editing its colors.`}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form id="create-saved-theme-form" noValidate onSubmit={createTheme}>
              <Field data-invalid={createError !== null}>
                <FieldLabel htmlFor="create-saved-theme-name">{t`Theme name`}</FieldLabel>
                <Input
                  ref={createNameRef}
                  id="create-saved-theme-name"
                  value={createName}
                  autoFocus
                  autoComplete="off"
                  required
                  readOnly={isCreating}
                  aria-invalid={createError !== null}
                  aria-describedby={
                    createError
                      ? 'create-saved-theme-help create-saved-theme-error'
                      : 'create-saved-theme-help'
                  }
                  onChange={(event) => {
                    setCreateName(event.target.value);
                    if (createError) setCreateError(null);
                  }}
                />
                <FieldDescription id="create-saved-theme-help" className="font-mono">
                  {createIdentity.ok
                    ? t`ID: ${createIdentity.stem}`
                    : t`We’ll create a safe theme ID from this name.`}
                </FieldDescription>
                {createError ? (
                  <FieldError id="create-saved-theme-error">{createError}</FieldError>
                ) : null}
              </Field>
            </form>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isCreating}
              onClick={() => setCreateOpen(false)}
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" form="create-saved-theme-form" disabled={isCreating}>
              {isCreating ? t`Creating…` : t`Create & edit`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
