import {
  type Config,
  ConfigSchema,
  type ConfigValidationError,
  getFieldMeta,
  isKnownConfigError,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, RotateCcw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { type ControllerRenderProps, type FieldPath, useFormContext } from 'react-hook-form';
import { narrowThemePreference, ThemePicker } from '@/components/ThemePicker';
import { Button } from '@/components/ui/button';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  colorThemeMode,
  colorThemeResetPatch,
  colorThemeWritePatch,
  customThemeKind,
  resolveCustomScheme,
  resolveModePreference,
} from '@/lib/color-themes';
import { useConfigContextOptional } from '@/lib/config-context';
import { recordLanguagePreferenceChanged } from '@/lib/language-telemetry';
import { recordSavedThemeAssignment } from '@/lib/saved-themes-telemetry';
import { applyColorThemeToDom } from '@/lib/use-apply-config-color-theme';
import { narrowLanguagePreference } from '@/lib/use-apply-config-language';
import { cn } from '@/lib/utils';
import { LanguageSelect } from './LanguageSelect';
import { SavedThemesTiles } from './SavedThemesTiles';
import {
  getEnumOptions,
  getFieldDefault,
  getLeafTypeTag,
  resolveLeafSchema,
} from './schema-walker';
import type { FieldDef } from './settings-fields';
import type { SlotForwardedProps } from './slot-forwarded-props';
import { pickFirstIssueForPath } from './use-config-form';

export type Scope = 'user' | 'project';

export function firstIssuePath(error: ConfigValidationError): string | null {
  if (!isKnownConfigError(error) || error.code !== 'SCHEMA_INVALID') return null;
  const first = error.issues[0];
  if (!first || first.path.length === 0) return null;
  return first.path.map(String).join('.');
}

export function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-4 w-64" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

interface SettingsFieldProps {
  field: FieldDef;
  scope: Scope;
  commitField: (name: FieldPath<Config>) => boolean;
  isFlashed: boolean;
}

export function SettingsField({ field, scope, commitField, isFlashed }: SettingsFieldProps) {
  'use no memo';
  const { t } = useLingui();
  const form = useFormContext<Config>();
  const { setTheme } = useTheme();
  const configContext = useConfigContextOptional();
  const leafSchema = resolveLeafSchema(ConfigSchema, field.path);
  const typeTag = leafSchema ? getLeafTypeTag(leafSchema) : undefined;
  const defaultValue = leafSchema ? getFieldDefault(leafSchema) : undefined;
  const enumOptions = leafSchema ? getEnumOptions(leafSchema) : undefined;

  const meta = leafSchema ? getFieldMeta(leafSchema) : undefined;
  const scopeMismatch =
    (meta?.scope === 'project' && scope !== 'project') ||
    (meta?.scope === 'user' && scope !== 'user');

  const dottedName = field.path.join('.') as FieldPath<Config>;
  const labelText = t(field.label);

  const [savedTick, setSavedTick] = useState(false);
  const savedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    },
    [],
  );

  const flashSavedTick = () => {
    setSavedTick(true);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
  };

  const runCommit = (): boolean => {
    const ok = commitField(dottedName);
    if (ok) flashSavedTick();
    return ok;
  };

  const runCommitIfDirty = (): boolean => {
    if (!form.getFieldState(dottedName).isDirty) return true;
    return runCommit();
  };

  const reset = () => {
    if (field.control === 'theme-tiles') {
      const binding = configContext?.userBinding;
      if (!binding) return;
      const result = binding.patch({ appearance: colorThemeResetPatch() });
      if (result.ok) {
        flashSavedTick();
      } else {
        form.setError(dottedName, {
          type: 'manual',
          message: pickFirstIssueForPath(result.error, dottedName),
        });
      }
      return;
    }
    const target = defaultValue === undefined ? null : defaultValue;
    form.setValue(dottedName, target as never, { shouldDirty: false });
    if (field.control === 'theme-cards') setTheme(narrowThemePreference(target));
    runCommit();
  };

  const wrapperClass = cn('relative', isFlashed && 'animate-settings-flash');

  return (
    <FormField
      control={form.control}
      name={dottedName}
      render={({ field: ctl }) => {
        const showResetButton =
          !scopeMismatch && (defaultValue !== undefined || ctl.value !== undefined);

        return (
          <FormItem className={wrapperClass} data-field={field.path.join('.')} data-scope={scope}>
            <div className="flex items-center justify-between gap-2">
              <FormLabel className="text-sm font-medium">{labelText}</FormLabel>
              {showResetButton ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-muted-foreground opacity-60 hover:opacity-100"
                      onClick={reset}
                      aria-label={t`Reset ${labelText} to default`}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Reset to default</Trans>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            {field.description ? (
              <FormDescription className="text-muted-foreground text-1sm">
                {t(field.description)}
              </FormDescription>
            ) : null}
            <div className="flex items-center gap-2">
              <FormControl>
                <FieldControlBody
                  field={field}
                  ctl={ctl}
                  typeTag={typeTag}
                  enumOptions={enumOptions}
                  onCommit={runCommitIfDirty}
                  onRevertToBaseline={() => form.resetField(dottedName, { keepError: true })}
                  onSavedOutsideForm={flashSavedTick}
                  onWriteRejected={(error) => {
                    form.setError(dottedName, {
                      type: 'manual',
                      message: pickFirstIssueForPath(error, dottedName),
                    });
                  }}
                />
              </FormControl>
              <SavedIndicator visible={savedTick} srOnly={selfIndicating(field.control)} />
            </div>
            <FormMessage data-field-error={field.path.join('.')} />
          </FormItem>
        );
      }}
    />
  );
}

function selfIndicating(control: FieldDef['control']): boolean {
  return control === 'theme-tiles' || control === 'theme-cards';
}

interface FieldControlBodyProps {
  field: FieldDef;
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  typeTag: string | undefined;
  enumOptions: readonly string[] | undefined;
  onCommit: () => boolean;
  onRevertToBaseline: () => void;
  onSavedOutsideForm: () => void;
  onWriteRejected: (error: ConfigValidationError) => void;
}

function FieldControlBody({
  field,
  ctl,
  typeTag,
  enumOptions,
  onCommit,
  onRevertToBaseline,
  onSavedOutsideForm,
  onWriteRejected,
  ...slotForwarded
}: FieldControlBodyProps & SlotForwardedProps) {
  'use no memo';
  const { t } = useLingui();
  const { setTheme, systemTheme } = useTheme();
  const config = useConfigContextOptional();
  const merged = config?.merged ?? null;
  if (field.control === 'language-select') {
    return (
      <LanguageSelect
        {...slotForwarded}
        value={ctl.value}
        ref={ctl.ref}
        onBlur={ctl.onBlur}
        onValueChange={(next) => {
          const previous = narrowLanguagePreference(ctl.value) ?? 'system';
          if (previous !== next) {
            recordLanguagePreferenceChanged({ from: previous, to: next });
          }
          ctl.onChange(next);
          onCommit();
        }}
      />
    );
  }
  if (field.control === 'theme-cards') {
    const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
    return (
      <ThemePicker
        {...wrapperSlotProps}
        firstItemId={forwardedId}
        value={narrowThemePreference(ctl.value)}
        aria-label={t(field.label)}
        onValueChange={(next) => {
          const previousTheme = narrowThemePreference(ctl.value);
          setTheme(next);
          ctl.onChange(next);
          if (onCommit()) return;
          setTheme(previousTheme);
          onRevertToBaseline();
        }}
      />
    );
  }
  if (field.control === 'theme-tiles') {
    const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
    const customSeed = merged?.appearance?.customTheme;
    const modePreference = merged?.appearance?.theme;
    const slotMode = resolveModePreference(modePreference, systemTheme === 'dark');
    return (
      <SavedThemesTiles
        {...wrapperSlotProps}
        firstItemId={forwardedId}
        appearance={merged?.appearance}
        customSeed={customSeed}
        slotMode={slotMode}
        aria-label={t(field.label)}
        onAssign={(slot, id, selection, themes) => {
          const binding = config?.userBinding;
          if (!binding) return;
          const next = { ...selection, [slot]: id };
          const forcedMode = (candidate: typeof selection): 'light' | 'dark' | undefined => {
            const palette = candidate[slotMode];
            return palette === 'custom'
              ? customThemeKind(resolveCustomScheme(customSeed))
              : colorThemeMode(palette, themes);
          };
          applyColorThemeToDom({
            selection: next,
            modePreference,
            slotMode,
            customSeed,
            themes,
          });
          const nextMode = forcedMode(next);
          if (nextMode) setTheme(nextMode);
          const result = binding.patch({ appearance: colorThemeWritePatch(next) });
          if (result.ok) {
            recordSavedThemeAssignment(next);
            onSavedOutsideForm();
            return;
          }
          applyColorThemeToDom({ selection, modePreference, slotMode, customSeed, themes });
          setTheme(forcedMode(selection) ?? modePreference ?? 'system');
          onWriteRejected(result.error);
        }}
      />
    );
  }
  if (typeTag === 'boolean') {
    return (
      <Switch
        {...slotForwarded}
        checked={Boolean(ctl.value)}
        ref={ctl.ref}
        onCheckedChange={(next) => {
          ctl.onChange(next);
          onCommit();
        }}
        onBlur={ctl.onBlur}
      />
    );
  }
  if (typeTag === 'enum' && enumOptions && enumOptions.length > 0) {
    if (field.control === 'enum-toggle' || enumOptions.length <= 4) {
      const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
      return (
        <ToggleGroup
          {...wrapperSlotProps}
          type="single"
          value={typeof ctl.value === 'string' ? ctl.value : ''}
          ref={ctl.ref}
          onValueChange={(next) => {
            if (!next) return;
            ctl.onChange(next);
            onCommit();
          }}
          onBlur={ctl.onBlur}
          variant="segmented"
          size="sm"
          spacing={1}
          className="bg-muted dark:bg-background p-0.5 rounded-lg"
          aria-label={t(field.label)}
        >
          {enumOptions.map((opt, idx) => (
            <ToggleGroupItem
              key={opt}
              value={opt}
              id={idx === 0 ? forwardedId : undefined}
              className="text-1sm capitalize"
            >
              {opt}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      );
    }
  }
  if (typeTag === 'number' || typeTag === 'int') {
    return <NumberControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
  }
  if (typeTag === 'array') {
    return <StringArrayControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
  }
  return <StringControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
}

function StringControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  return (
    <Input
      {...slotForwarded}
      value={typeof ctl.value === 'string' ? ctl.value : ''}
      ref={ctl.ref}
      onChange={(e) => ctl.onChange(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        }
      }}
      className="h-8 text-sm"
    />
  );
}

function NumberControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  const [pendingText, setPendingText] = useState(ctl.value === undefined ? '' : String(ctl.value));
  const lastSyncedValueRef = useRef(ctl.value);

  useEffect(() => {
    if (lastSyncedValueRef.current === ctl.value) return;
    setPendingText(ctl.value === undefined ? '' : String(ctl.value));
    lastSyncedValueRef.current = ctl.value;
  }, [ctl.value]);

  const commitText = () => {
    const parsed = Number(pendingText);
    if (!Number.isFinite(parsed)) {
      ctl.onChange(pendingText as unknown as number);
      onCommit();
      return;
    }
    ctl.onChange(parsed);
    onCommit();
    lastSyncedValueRef.current = parsed as unknown as Config[keyof Config];
  };

  return (
    <Input
      {...slotForwarded}
      type="number"
      value={pendingText}
      ref={ctl.ref}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        commitText();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitText();
        }
      }}
      className="h-8 w-28 text-sm tabular-nums"
    />
  );
}

function StringArrayControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  const initial = Array.isArray(ctl.value) ? (ctl.value as string[]).join('\n') : '';
  const [pendingText, setPendingText] = useState(initial);
  const lastSyncedRef = useRef(initial);

  useEffect(() => {
    const incoming = Array.isArray(ctl.value) ? (ctl.value as string[]).join('\n') : '';
    if (incoming === lastSyncedRef.current) return;
    setPendingText(incoming);
    lastSyncedRef.current = incoming;
  }, [ctl.value]);

  const commitText = () => {
    const parsed = pendingText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    ctl.onChange(parsed);
    onCommit();
    lastSyncedRef.current = parsed.join('\n');
  };

  return (
    <Textarea
      {...slotForwarded}
      value={pendingText}
      ref={ctl.ref}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        commitText();
      }}
      rows={Math.max(2, Math.min(6, pendingText.split('\n').length))}
      className="field-sizing-fixed min-h-16 rounded-md bg-background px-3 py-1.5 font-mono text-xs md:text-xs dark:bg-background"
    />
  );
}

export function SavedIndicator({
  visible,
  srOnly = false,
}: {
  visible: boolean;
  srOnly?: boolean;
}) {
  return (
    <span role="status" aria-live="polite" className={cn('text-emerald-600', srOnly && 'sr-only')}>
      {visible ? (
        <>
          {srOnly ? null : <Check aria-hidden="true" className="size-3.5" />}
          <span className="sr-only">
            <Trans>Saved</Trans>
          </span>
        </>
      ) : null}
    </span>
  );
}
