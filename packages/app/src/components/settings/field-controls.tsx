/**
 * Shared schema-form field machinery for the Settings dialog body: the
 * per-field wrapper (`SettingsField`), the type-tag-driven control
 * dispatch (`FieldControlBody` + the string/number/array control
 * bodies), and the small widgets the section files compose
 * (`SavedIndicator`, `SectionSkeleton`).
 *
 * Auto-save: per-control commits via the harness-owned `commitField`
 * (see `use-config-form.ts`). Client-side L1 validation gates writes.
 * Per-field reset writes the schema default (or null per RFC 7396 for
 * fields without a default).
 */

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

/**
 * Internal scope tag for routing each section to its config binding.
 * Not exposed to the user — there's no top-level scope toggle in the
 * new design. Sections under USER use the user binding; sections under
 * THIS PROJECT use the project binding.
 */
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
  // 'use no memo' — the FormField inline render-prop below destructures
  // `ctl` (a ControllerRenderProps with a `ref` field), which the React
  // Compiler heuristic flags as ref-access during render. Same rationale
  // as FieldControlBody / control bodies.
  'use no memo';
  const { t } = useLingui();
  const form = useFormContext<Config>();
  // Safe unconditionally: next-themes returns a no-op `setTheme` with no
  // provider mounted, which is how the unit harnesses render this.
  const { setTheme } = useTheme();
  const configContext = useConfigContextOptional();
  const leafSchema = resolveLeafSchema(ConfigSchema, field.path);
  const typeTag = leafSchema ? getLeafTypeTag(leafSchema) : undefined;
  const defaultValue = leafSchema ? getFieldDefault(leafSchema) : undefined;
  const enumOptions = leafSchema ? getEnumOptions(leafSchema) : undefined;

  // Defensive cross-scope check — every FieldDef in the new design is
  // routed to a section that matches its schema scope, so this should
  // never fire. Keeping the meta lookup as a guard rail; we don't
  // render a readonly note (the sidebar IA prevents the cross-scope
  // case from being reachable).
  const meta = leafSchema ? getFieldMeta(leafSchema) : undefined;
  const scopeMismatch =
    (meta?.scope === 'project' && scope !== 'project') ||
    (meta?.scope === 'user' && scope !== 'user');

  const dottedName = field.path.join('.') as FieldPath<Config>;
  const labelText = t(field.label);

  const [savedTick, setSavedTick] = useState(false);
  // Tracks the SavedIndicator timeout so an unmount mid-flash doesn't fire
  // `setSavedTick(false)` on a torn-down component (React warning).
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

  /**
   * Run `commitField` (the harness-owned binding.patch + form.setError /
   * form.clearErrors path) and flash the SavedIndicator on success. The
   * value committed is whatever currently lives in the form at `name` —
   * call sites are responsible for writing the desired value via
   * `ctl.onChange` (per-control commits) or `form.setValue` (reset path)
   * BEFORE invoking `runCommit`.
   */
  const runCommit = (): boolean => {
    const ok = commitField(dottedName);
    if (ok) flashSavedTick();
    return ok;
  };

  /**
   * Per-interaction commit (blur/change/Enter). Skips no-op commits where
   * the field is not dirty against its current `defaultValue` baseline —
   * after a successful commit, `useConfigForm` re-baselines via
   * `form.resetField(name, { defaultValue: value })`, so subsequent
   * blurs on an unchanged field correctly report `isDirty: false` and
   * the unconditional `binding.patch → Y.Text delete+insert` cycle is
   * avoided. Returns true on no-op (no error to surface).
   *
   * The reset path bypasses this guard by calling `runCommit` directly:
   * `form.setValue(name, target, { shouldDirty: false })` leaves the
   * field non-dirty, but the commit is still intentional (the user
   * clicked Reset).
   */
  const runCommitIfDirty = (): boolean => {
    if (!form.getFieldState(dottedName).isDirty) return true;
    return runCommit();
  };

  /**
   * Reset writes the schema default (or `null` for fields with no
   * default — null-as-clear preserves RFC 7396 semantics) into form
   * state, then commits via the harness. `shouldDirty: false` so the
   * field doesn't end up flagged as dirty after reset.
   */
  const reset = () => {
    // The theme row is anchored to a single path but represents both slots, so
    // the generic per-path reset would clear the light palette and silently
    // leave the dark one assigned, under a label that says "reset to default".
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
    // The theme row is the one generic-reset field that paints the whole app.
    // Clearing the value alone snaps the card to System — what an unset
    // preference resolves to — while the window stays in the mode the old value
    // forced, so the checked card and the applied theme disagree until the next
    // merged-effect. The toggle this replaced hid that by rendering nothing
    // selected for an unset value; the cards state it outright.
    if (field.control === 'theme-cards') setTheme(narrowThemePreference(target));
    runCommit();
  };

  const wrapperClass = cn('relative', isFlashed && 'animate-settings-flash');

  return (
    <FormField
      control={form.control}
      name={dottedName}
      render={({ field: ctl }) => {
        // Reset-button visibility derives from the form's reactive value
        // (`ctl.value`) so it updates in lockstep with user edits, external
        // Y.Text updates, and resets.
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

/**
 * Controls that already show their own selection state — each renders a check
 * badge on the chosen card or tile and spans the full row — so the row's saved
 * tick would be a redundant second checkmark competing for the same width. It
 * stays in the tree for screen readers, which get no equivalent from the badge
 * (the badge is decorative and `aria-hidden`).
 */
function selfIndicating(control: FieldDef['control']): boolean {
  return control === 'theme-tiles' || control === 'theme-cards';
}

interface FieldControlBodyProps {
  field: FieldDef;
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  typeTag: string | undefined;
  enumOptions: readonly string[] | undefined;
  /**
   * Commits the field's CURRENT form value via the harness's
   * `commitField`. Call sites must write the desired value through
   * `ctl.onChange` BEFORE invoking — the commit reads from form state.
   */
  onCommit: () => boolean;
  /**
   * Restore the field to its committed baseline and clear its dirty flag,
   * keeping any error the rejection surfaced. Owned by the caller because only
   * it holds the form handle; `ctl.onChange(previous)` is NOT equivalent —
   * writing a value back leaves the key present, which RHF scores as dirty
   * against a baseline that never had one.
   */
  onRevertToBaseline: () => void;
  /**
   * Flash the saved indicator for a control that writes through the binding
   * directly instead of the form's per-field commit. `onCommit` is not usable
   * there: it re-reads the form value for this field's single path, which for a
   * multi-path atomic write is both stale and narrower than what was written.
   */
  onSavedOutsideForm: () => void;
  /**
   * Surface a rejected binding write on this row, the same way `runCommit`
   * surfaces one for a form-committed field.
   */
  onWriteRejected: (error: ConfigValidationError) => void;
}

/**
 * Type-tag-driven dispatch for the inner control element. Returns a
 * single React element so the wrapping `<FormControl>` (Radix Slot)
 * can forward `id`, `aria-describedby`, and `aria-invalid` to the
 * underlying DOM input. The Slot clones this component with those props;
 * destructure + forward as `...slotForwarded` into each leaf — without
 * this hop the a11y attributes hit FieldControlBody and stop, breaking
 * screen-reader notification of L1 rejection (ARIA §4.10).
 *
 * `'use no memo'` opts out of React Compiler memoization because RHF's
 * `ControllerRenderProps` exposes a `ref` field; the compiler heuristic
 * flags every property access on objects with `ref` as ref-access during
 * render. The control bodies below use the same opt-out for the same
 * reason.
 */
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
  // Optimistic theme apply. next-themes' `useTheme` is safe to
  // call unconditionally — it returns a no-op `setTheme` when no
  // <ThemeProvider> is mounted (e.g. in unit harnesses), and the app always
  // mounts one in `main.tsx`. Only the two theme controls below call
  // `setTheme`, so every other control is unaffected.
  // `systemTheme` is the OS preference, independent of the mode a palette
  // forces — it's what `appearance.theme: 'system'` resolves to.
  const { setTheme, systemTheme } = useTheme();
  // Optional: the theme-tiles control reads the custom-theme seed from config,
  // but FieldControlBody also renders in provider-less unit harnesses.
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
          // Recorded HERE rather than where the language is applied, because
          // only this site knows the user did it. `useApplyConfigLanguage` also
          // runs for an external edit to `global.yml` and for another window's
          // change arriving over the CRDT, which would inflate the count and
          // attribute someone else's pick to this session.
          //
          // Guarded on an actual difference so the count means changes rather
          // than interactions, without resting on whether the underlying Select
          // chooses to fire for a re-pick of the value already in force.
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
    // Slot.Root forwards `id` onto its child, but the picker's group root is a
    // <div> — not a labelable element — so `<label htmlFor>` on it would focus
    // nothing. The id rides the first card instead, while the remaining slot
    // props go to the group, which is what they describe. The picker has to
    // NAME those two props: it destructures without a rest spread, so anything
    // handed down that it does not name is dropped rather than reaching the DOM.
    const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
    // No `ref` / `onBlur`, matching the theme-tiles card control: RHF's
    // `form.setFocus` was already inert for this field (the enum-toggle root it
    // replaced was a non-focusable <div>), and wiring the Controller ref into
    // one card here would leave the two card controls asymmetric.
    return (
      <ThemePicker
        {...wrapperSlotProps}
        firstItemId={forwardedId}
        // Read the stored preference, never next-themes' resolved mode: a
        // 'system' pick resolves to 'dark'/'light' and would check the wrong
        // card. An unset value reads as 'system', which is how it behaves.
        value={narrowThemePreference(ctl.value)}
        aria-label={t(field.label)}
        onValueChange={(next) => {
          // Read before the change: `ctl.value` is the render-time value, so
          // this is what was last committed. The two reverts below want
          // different shapes of it — see the rejection branch.
          const previousTheme = narrowThemePreference(ctl.value);
          // Optimistic flip, same contract as the toggle this replaced: apply
          // via next-themes synchronously so the UI changes on click rather
          // than after the patch -> user-config Y.Text -> ConfigProvider
          // merged-effect round-trip. `next` is forwarded verbatim so 'system'
          // stays the OS-tracking lever. The merged-effect still drives remote
          // clients and Electron native chrome, and no-ops here (same value ->
          // next-themes state bailout), so there is no double-flip.
          setTheme(next);
          ctl.onChange(next);
          if (onCommit()) return;
          // Rejected write (an unparseable config.yml, a binding that refused).
          // The paint already landed, so leaving it shows a theme nothing
          // persisted until a later merged-effect silently undoes it. Both legs
          // revert together: restoring only next-themes leaves the checked card
          // disagreeing with the applied mode, and restoring only the form
          // value leaves the reverse.
          //
          // The two legs revert differently on purpose. next-themes needs a
          // concrete preference, so it takes the narrowed value. The form goes
          // back through `resetField`, not `onChange`: `appearance.theme` is
          // unset by default, and writing any value back — narrowed OR raw —
          // leaves the row dirty against a baseline that has no such key.
          // `useConfigForm` bridges remote updates with `keepDirtyValues: true`,
          // so a permanently dirty row silently stops absorbing theme changes
          // from other windows or an external config edit.
          setTheme(previousTheme);
          onRevertToBaseline();
        }}
      />
    );
  }
  if (field.control === 'theme-tiles') {
    const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
    const customSeed = merged?.appearance?.customTheme;
    // The mode on screen — read from `appearance.theme` (falling back to the OS
    // for 'system'/unset), never from next-themes' resolved mode, which carries
    // whatever the applied palette forced.
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
          // Paint first, persist second — but only when there is somewhere to
          // persist to. Without the binding the optimistic apply would leave
          // the screen showing a palette no config carries, which the next
          // ConfigProvider pass silently reverts.
          const binding = config?.userBinding;
          if (!binding) return;
          const next = { ...selection, [slot]: id };
          // Optimistic apply: paint the palette overlay synchronously and flip
          // next-themes to the palette's forced mode so `dark:` variants land
          // immediately. Assigning the slot the user is NOT currently in changes
          // nothing on screen — `applyColorThemeToDom` still runs, to refresh
          // the pre-paint cache for the next time that mode comes around.
          // The mode a selection forces, or undefined for a palette-less
          // `default`, which leaves the user's own light/dark preference alone.
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
          // Both slots are written in ONE patch (and the pre-pair `colorTheme`
          // retired) rather than through the form's per-field commit, which
          // carries a single path. RHF re-syncs from the binding subscription;
          // neither field is dirty here, so nothing of the user's is stomped.
          const result = binding.patch({ appearance: colorThemeWritePatch(next) });
          if (result.ok) {
            recordSavedThemeAssignment(next);
            onSavedOutsideForm();
            return;
          }
          // Every other field routes a rejected write into its own
          // <FormMessage> through `runCommit`. Writing through the binding
          // directly skipped that, so a rejection (a hand-edited config that
          // no longer parses, say) left the palette painted with nothing
          // persisted and nothing said. Repaint the committed selection and
          // surface the error on this row.
          applyColorThemeToDom({ selection, modePreference, slotMode, customSeed, themes });
          // The optimistic apply flipped two things, so the revert has to undo
          // both. Restoring only the palette attribute leaves a cross-variant
          // pick's forced `.dark` class on the previous palette.
          // Falls back to 'system' the way ConfigProvider does: an unset
          // `appearance.theme` still has a mode to go back to, and without it a
          // failed pick would strand the flip it made on the way in.
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
      // Slot.Root forwards `id` onto its child; ToggleGroup root renders a
      // <div>, which is not a labelable element — `<label htmlFor>` on a
      // div doesn't focus its descendants on click. Pluck the id and put
      // it on the first ToggleGroupItem (a <button>) so label-click moves
      // focus into the group. aria-describedby/aria-invalid stay on the
      // wrapper since they describe the group as a whole.
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
              // Raw schema identifiers, so they need casing; no enum field
              // declares this control today, and the only translated label set
              // it ever carried belonged to the theme field, which now renders
              // as cards.
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

/**
 * String-typed text input. Form value IS the displayed text — no local
 * presentation buffer needed. Commits on blur or Enter.
 */
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

/**
 * Number-typed input. Form value is a `number`; the textbox needs a
 * string presentation buffer so the user can type intermediate text
 * (`'1.'`, `'-'`) without it parsing prematurely. The local `pendingText`
 * resyncs with `ctl.value` whenever the user isn't actively editing.
 */
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
    // Skip if ctl.value hasn't changed since the last sync (dedup —
    // avoids resetting pendingText on unrelated re-renders). When
    // ctl.value DOES change, refresh pendingText to track it.
    if (lastSyncedValueRef.current === ctl.value) return;
    setPendingText(ctl.value === undefined ? '' : String(ctl.value));
    lastSyncedValueRef.current = ctl.value;
  }, [ctl.value]);

  const commitText = () => {
    const parsed = Number(pendingText);
    if (!Number.isFinite(parsed)) {
      // Let L1 reject + show a typed FormMessage error rather than silently swallow.
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

/**
 * String-array textarea. Form value is `string[]`; the textarea displays
 * a newline-joined string. Local `pendingText` resyncs with `ctl.value`
 * whenever the user isn't actively editing. Commit splits on newlines,
 * trims each entry, and filters empty lines.
 */
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
    // shadcn Textarea with overrides that keep the pre-migration rendering:
    // `field-sizing-fixed` restores rows-driven height (the base
    // `field-sizing-content` would auto-grow past the 6-row cap), and the
    // background/text overrides pin the monospace xs-size look across
    // breakpoints and color schemes.
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
  // Live region — auto-save replaces an explicit Save button, so this
  // checkmark IS the save confirmation. Polite announcement so screen
  // readers say "Saved" without interrupting other speech (WCAG 4.1.3).
  // Always render the wrapper so the SR-only text node is present at
  // mount time; the visible checkmark is the only thing that toggles.
  // `srOnly` keeps the announcement but never paints the checkmark — for
  // controls whose committed value is already visually self-evident (the
  // theme tiles repaint the whole app) and whose full-width layout the
  // appearing icon would momentarily compress.
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
