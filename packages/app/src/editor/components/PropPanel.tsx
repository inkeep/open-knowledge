/**
 * PropPanel — auto-generated controls for jsxComponent props.
 *
 * Renders inside a floating div below the selected component block.
 * Controls derived from descriptor.props:
 *   string → text input
 *   boolean → toggle switch
 *   enum → dropdown (select)
 *   number → numeric input
 *   reactnode → hidden (content hole is the edit surface)
 *   hidden flag → suppressed
 *   advanced flag → moved into a collapsible "Advanced" section
 *
 * Panel suppressed when no editable props exist.
 * Change handlers call updateAttributes with sourceDirty:true.
 */

import type { PropDef } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronDown, Loader2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ColorPickerInput } from '@/editor/components/ColorPickerInput.tsx';
import { IconPickerInput } from '@/editor/components/IconPickerInput.tsx';
import { SrcAutocomplete } from '@/editor/components/SrcAutocomplete.tsx';
import { uploadFile } from '@/editor/image-upload/upload-file.ts';
import type { JsxComponentDescriptor } from '@/editor/registry/types.ts';
import { getAutoFocusedPropName, humanizePropName } from '@/editor/utils/editor-strings.ts';
import {
  cssLengthValidationMessage,
  validateCssLength,
} from '@/editor/utils/validate-css-length.ts';
import {
  mediaKindForAccept,
  mediaUrlPlaceholder,
  mediaUrlValidationMessage,
  validateMediaUrl,
} from '@/editor/utils/validate-media-url.ts';
import { CodeMirrorPropInput } from './CodeMirrorPropInput.tsx';

/**
 * Per-descriptor localStorage key for persisting the Advanced section's
 * open/closed state. Opening Advanced on `<img>` does not auto-open it on
 * `<Callout>` — each descriptor has independent state.
 */
function advancedOpenStateKey(descriptorName: string): string {
  return `ok.propPanel.advanced.${descriptorName}`;
}

/**
 * Read the persisted Advanced-section open state for a descriptor. Returns
 * `false` when no entry exists, when storage is unavailable (privacy mode,
 * SSR), or when the stored value is malformed. Throws are swallowed — the
 * panel still works without persistence.
 */
export function readAdvancedOpenState(descriptorName: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(advancedOpenStateKey(descriptorName)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the Advanced-section open state for a descriptor. Throws are
 * swallowed (storage quota / privacy mode); the in-memory React state still
 * reflects the user's intent for the lifetime of the panel.
 */
export function persistAdvancedOpenState(descriptorName: string, open: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(advancedOpenStateKey(descriptorName), open ? 'true' : 'false');
  } catch {
    // ignore
  }
}

/**
 * Count the number of advanced props whose current value differs from the
 * declared `defaultValue`. A prop with no `defaultValue` counts as "set"
 * when its current value is anything other than `undefined`. Drives the
 * Advanced trigger's count badge.
 */
export function countAdvancedSet(
  advancedProps: PropDef[],
  values: Record<string, unknown>,
): number {
  let count = 0;
  for (const p of advancedProps) {
    const current = values[p.name];
    const declaredDefault = 'defaultValue' in p ? p.defaultValue : undefined;
    if (current !== undefined && current !== declaredDefault) count += 1;
  }
  return count;
}

/**
 * Behavioral half of the PropPanel upload affordance — exported so the unit
 * test can drive the success/error semantics without a real DOM. The button
 * component below wraps this with the in-flight `uploading` state and the
 * file-input value reset.
 */
async function runUpload(
  file: File,
  accept: readonly string[],
  onUploaded: (url: string) => void,
): Promise<void> {
  try {
    const { url } = await uploadFile(file, accept);
    onUploaded(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast.error(t`Upload failed: ${message}`);
  }
}

interface PropPanelProps {
  /**
   * Active descriptor — drives the prop controls (form-scoped to the
   * descriptor's own `props`).
   */
  descriptor: JsxComponentDescriptor;
  values: Record<string, unknown>;
  onChange: (propName: string, value: unknown) => void;
  /**
   * Owner-side handler for "the user is done with this panel" gestures
   * (Enter on a single-line string input; clicking the Done button if
   * the consumer renders one). PropPanel itself owns no popover state —
   * its parent (`JsxComponentView`) does — so it just invokes this
   * callback and lets the parent close. Optional so standalone preview
   * surfaces (slash-menu hover card) can render PropPanel without an
   * owner-side close target.
   */
  onDismiss?: () => void;
}

export function PropPanel({ descriptor, values, onChange, onDismiss }: PropPanelProps) {
  const editableProps = descriptor.props.filter(
    (p) => !('hidden' in p && p.hidden) && p.hideWhen?.(values) !== true && p.type !== 'reactnode',
  );

  const commonProps = editableProps.filter((p) => !('advanced' in p && p.advanced));
  const advancedProps = editableProps.filter((p) => 'advanced' in p && p.advanced);
  const advancedSetCount = countAdvancedSet(advancedProps, values);
  const autoFocusedPropName = getAutoFocusedPropName(descriptor.props);

  // Read persisted state once at mount; the controlled `open` lets us call
  // `persistAdvancedOpenState` on every change. React Compiler memoizes this
  // useState initializer.
  const [advancedOpen, setAdvancedOpen] = useState(() => readAdvancedOpenState(descriptor.name));

  if (editableProps.length === 0) return null;

  return (
    <div data-prop-panel="" className="flex flex-col gap-4 py-2 text-sm">
      {commonProps.map((propDef) => (
        <PropControl
          key={propDef.name}
          propDef={propDef}
          value={values[propDef.name]}
          onChange={(v) => onChange(propDef.name, v)}
          onDismiss={onDismiss}
          isAutoFocused={propDef.name === autoFocusedPropName}
        />
      ))}
      {advancedProps.length > 0 && (
        <>
          <div className="my-1 border-t border-border" />
          <Collapsible
            open={advancedOpen}
            onOpenChange={(o) => {
              setAdvancedOpen(o);
              persistAdvancedOpenState(descriptor.name, o);
            }}
          >
            <CollapsibleTrigger
              data-prop-panel-advanced-trigger=""
              className="group flex w-full items-center justify-between rounded px-1 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground uppercase font-mono"
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                <Trans>Advanced</Trans>
              </span>
              {advancedSetCount > 0 && (
                <Badge variant="secondary" data-prop-panel-advanced-count="">
                  {advancedSetCount}
                </Badge>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-2">
              {advancedProps.map((propDef) => (
                <PropControl
                  key={propDef.name}
                  propDef={propDef}
                  value={values[propDef.name]}
                  onChange={(v) => onChange(propDef.name, v)}
                  onDismiss={onDismiss}
                  isAutoFocused={propDef.name === autoFocusedPropName}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}

/**
 * Exhaustive-check sentinel for `PropDef.type`. Adding a new PropDef
 * variant without extending the switch below produces a compile error
 * here — exactly the signal we want, so a new variant cannot ship
 * silently without UI surface.
 */
function assertUnreachable(x: never): never {
  throw new Error(`PropPanel: unhandled PropDef type ${JSON.stringify(x)}`);
}

function PropControl({
  propDef,
  value,
  onChange,
  onDismiss,
  isAutoFocused,
}: {
  propDef: PropDef;
  value: unknown;
  onChange: (value: unknown) => void;
  onDismiss?: () => void;
  isAutoFocused: boolean;
}) {
  // Shared Enter-to-dismiss handler applied to every single-line `<Input>`
  // PropControl renders (string / cssLength / number). PropPanel auto-saves
  // on every keystroke, so Enter is acknowledgment — the form contract every
  // text input ships with. CodeMirror code editors keep Enter as newline
  // (multiline by design); the SrcAutocomplete branch routes Enter through
  // its own `onSubmit` prop so its "Enter picks the highlighted suggestion"
  // contract still takes priority. Optional callback → `undefined` handler
  // when the consumer doesn't supply `onDismiss` (standalone preview cards).
  const handleDismissKeyDown = onDismiss
    ? (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onDismiss();
        }
      }
    : undefined;
  switch (propDef.type) {
    case 'reactnode':
      // ReactNode props render as the component's NodeViewContent — no
      // PropPanel control. Explicit case so the exhaustiveness check
      // below narrows to `never` when every variant is handled.
      return null;
    case 'string': {
      const stringId = `prop-${propDef.name}`;
      const accept = propDef.accept;
      const showUpload = accept !== undefined && accept.length > 0;
      // Optional, no-default string props treat empty input as a clear:
      // emit `undefined` so the JsxComponentView onChange handler removes
      // the key entirely (preventing `<img srcset="" sizes="" title="" />`
      // empty-attr drift on disk). Required props and props with an
      // explicit `defaultValue: ''` (e.g. `alt`) keep the literal empty
      // string — those positions are semantically distinct from "absent."
      // Mirrors the number PropControl's clear-on-empty branch below.
      const treatEmptyAsUndefined = !propDef.required && propDef.defaultValue === undefined;

      // Code-shaped string props (LaTeX, Mermaid, JSON, HTML, YAML, …)
      // render via CodeMirror — line numbers, syntax highlighting, multi-
      // line editing. The same controlled-input semantics apply: the
      // CM editor reads from `value`, propagates back via `onChange`.
      // The `treatEmptyAsUndefined` branch is wired but dormant for the
      // current callsites (Math.formula and Mermaid.chart are both
      // `required: true`, so `treatEmptyAsUndefined` evaluates false). It
      // stays in place for any future optional code-shaped prop — do not
      // remove it. Upload affordance is intentionally omitted — code
      // props don't carry file URLs.
      if (propDef.language) {
        // a11y: `<label htmlFor>` only associates with native labelable
        // elements (input/button/select/etc.). The CodeMirror wrapper is
        // a `<div>`, so the host label is paired to CM's inner
        // `[contenteditable]` content DOM via `aria-labelledby` instead
        // — see `CodeMirrorPropInput`'s mount effect.
        const labelId = `${stringId}-label`;
        return (
          <div className="flex flex-col gap-1">
            <label id={labelId} htmlFor={stringId} className="text-xs text-muted-foreground">
              {humanizePropName(propDef.name)}
            </label>
            <CodeMirrorPropInput
              id={stringId}
              ariaLabelledBy={labelId}
              value={(value as string) ?? ''}
              language={propDef.language}
              onChange={(next) => {
                if (next === '' && treatEmptyAsUndefined) {
                  onChange(undefined);
                  return;
                }
                onChange(next);
              }}
              autoFocus={isAutoFocused}
            />
          </div>
        );
      }

      // Icon-picker variant: descriptor opts in via `iconPicker: true` on
      // the prop def (e.g. Callout.icon, Accordion.icon). Renders a text
      // input + popover trigger; the underlying value stays a free string
      // so emoji / plain text fallbacks still work. Mutually exclusive
      // with `language` (checked above) and `accept` (no upload chrome).
      if (propDef.iconPicker) {
        const currentIconValue = (value as string) ?? '';
        return (
          <div className="flex flex-col gap-1">
            <label htmlFor={stringId} className="text-xs text-muted-foreground">
              {humanizePropName(propDef.name)}
            </label>
            <IconPickerInput
              id={stringId}
              value={currentIconValue}
              onChange={(next) => {
                if (next === '' && treatEmptyAsUndefined) {
                  onChange(undefined);
                  return;
                }
                onChange(next);
              }}
              autoFocus={isAutoFocused}
            />
          </div>
        );
      }

      // Color-picker variant: descriptor opts in via `colorPicker: true`
      // (e.g. Callout.color). Renders a text input + swatch trigger that
      // opens the OS native color picker. The underlying value stays a
      // free string — author can paste any CSS color, the picker just
      // writes 7-char hex when used.
      if (propDef.colorPicker) {
        const currentColorValue = (value as string) ?? '';
        return (
          <div className="flex flex-col gap-1">
            <label htmlFor={stringId} className="text-xs text-muted-foreground">
              {humanizePropName(propDef.name)}
            </label>
            <ColorPickerInput
              id={stringId}
              value={currentColorValue}
              onChange={(next) => {
                if (next === '' && treatEmptyAsUndefined) {
                  onChange(undefined);
                  return;
                }
                onChange(next);
              }}
              autoFocus={isAutoFocused}
            />
          </div>
        );
      }

      // CSS-length validation: descriptor opts in via `cssLengthInput:
      // true` (Embed.width, Embed.height). Renders the same input chrome
      // as the media-URL branch but with a CSS-length validator. The
      // value persists either way — error is advisory not blocking, so a
      // typo doesn't strand the author's input.
      if (propDef.cssLengthInput) {
        const currentCssLength = (value as string) ?? '';
        const cssValidation = validateCssLength(currentCssLength);
        const cssError = cssValidation.valid ? null : cssLengthValidationMessage(cssValidation);
        return (
          <div className="flex flex-col gap-1">
            <label htmlFor={stringId} className="text-xs text-muted-foreground">
              {humanizePropName(propDef.name)}
            </label>
            <Input
              id={stringId}
              type="text"
              value={currentCssLength}
              placeholder="100px, 50%, 26rem, auto"
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '' && treatEmptyAsUndefined) {
                  onChange(undefined);
                  return;
                }
                onChange(raw);
              }}
              onKeyDown={handleDismissKeyDown}
              autoFocus={isAutoFocused}
              data-prop-autofocus={isAutoFocused ? '' : undefined}
              aria-invalid={cssError !== null ? true : undefined}
              aria-describedby={cssError !== null ? `${stringId}-error` : undefined}
              className="h-7 text-sm"
              data-prop-css-length-input=""
            />
            {cssError !== null && (
              // `aria-live="polite"` (not `role="alert"`) so the inline
              // error doesn't interrupt the screen reader mid-dictation
              // on every keystroke. `aria-invalid` + `aria-describedby`
              // on the input above already let AT users discover the
              // error when inspecting the field; the polite live region
              // announces only after the user pauses typing.
              <p
                id={`${stringId}-error`}
                data-prop-css-length-error=""
                className="text-xs text-destructive"
                aria-live="polite"
              >
                {cssError}
              </p>
            )}
          </div>
        );
      }

      // Media-URL props (img.src, video.src, video.poster, audio.src) carry
      // a MIME `accept` allowlist; the prop's media kind drives the
      // validator. A service-hosted watch URL pasted into the field emits
      // an inline error instead of silently committing a `src` the browser
      // cannot decode as a media file.
      const mediaKind = accept !== undefined ? mediaKindForAccept(accept) : undefined;
      const currentStringValue = (value as string) ?? '';
      const mediaValidation =
        mediaKind !== undefined ? validateMediaUrl(currentStringValue, mediaKind) : null;
      const mediaErrorMessage =
        mediaValidation !== null &&
        !mediaValidation.valid &&
        mediaKind !== undefined &&
        currentStringValue.trim().length > 0
          ? mediaUrlValidationMessage(mediaValidation, mediaKind)
          : null;
      const mediaPlaceholder = mediaKind !== undefined ? mediaUrlPlaceholder(mediaKind) : undefined;

      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={stringId} className="text-xs text-muted-foreground">
            {humanizePropName(propDef.name)}
          </label>
          {/* Two-row layout: src input on its own line, then the upload
              affordance below it as a labeled full-width button. UX
              research found users skipping the icon-only upload button
              entirely — the row-with-icon shape read as "URL field with a
              decoration on the right," not "URL field OR pick a file."
              Stacking the affordances and giving the upload button visible
              "Upload from computer" text makes the second path explicit. */}
          <div className="flex flex-col gap-1.5">
            {accept !== undefined ? (
              // Accept-bearing src input → autocomplete against existing
              // workspace assets that match the descriptor's MIME allowlist.
              // Selecting a suggestion inserts the asset's server-absolute
              // path (leading slash, mirroring PropUploadButton's output)
              // so the resulting attribute round-trips through validateMediaUrl
              // and renders byte-identically regardless of how the user
              // populated the field (type / upload / autocomplete).
              <SrcAutocomplete
                id={stringId}
                value={currentStringValue}
                onChange={(raw) => {
                  if (raw === '' && treatEmptyAsUndefined) {
                    onChange(undefined);
                    return;
                  }
                  onChange(raw);
                }}
                onSubmit={onDismiss}
                accept={accept}
                placeholder={mediaPlaceholder}
                autoFocus={isAutoFocused}
                dataPropAutofocus={isAutoFocused ? '' : undefined}
                ariaInvalid={mediaErrorMessage !== null ? true : undefined}
                ariaDescribedBy={mediaErrorMessage !== null ? `${stringId}-error` : undefined}
                className="h-7 text-sm"
              />
            ) : (
              // Pure string prop with no accept allowlist (e.g. Embed.src,
              // MirrorSource.src) — keep the plain Input. Autocomplete
              // against the asset library would suggest media files the
              // descriptor wasn't designed to render.
              <Input
                id={stringId}
                type="text"
                value={currentStringValue}
                placeholder={mediaPlaceholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '' && treatEmptyAsUndefined) {
                    onChange(undefined);
                    return;
                  }
                  onChange(raw);
                }}
                onKeyDown={handleDismissKeyDown}
                autoFocus={isAutoFocused}
                data-prop-autofocus={isAutoFocused ? '' : undefined}
                aria-invalid={mediaErrorMessage !== null ? true : undefined}
                aria-describedby={mediaErrorMessage !== null ? `${stringId}-error` : undefined}
                className="h-7 text-sm"
              />
            )}
            {showUpload && <PropUploadButton accept={accept} onUploaded={(url) => onChange(url)} />}
          </div>
          {mediaErrorMessage !== null && (
            // `aria-live="polite"` — see sibling CSS-length error
            // element above for the rationale. Both error elements were
            // `role="alert"` (== `aria-live="assertive"`) before, which
            // interrupted screen-reader dictation on every keystroke
            // while the validator's intermediate states flickered. The
            // `aria-invalid` + `aria-describedby` wiring on the input
            // is sufficient for AT discovery; the polite live region
            // announces only after the user pauses.
            <p
              id={`${stringId}-error`}
              data-prop-media-error=""
              className="text-xs text-destructive"
              aria-live="polite"
            >
              {mediaErrorMessage}
            </p>
          )}
        </div>
      );
    }

    case 'boolean': {
      const boolId = `prop-${propDef.name}`;
      const boolLabel = humanizePropName(propDef.name);
      return (
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={boolId} className="text-xs text-muted-foreground">
            {boolLabel}
          </label>
          <Switch
            id={boolId}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
      );
    }

    case 'enum': {
      const enumId = `prop-${propDef.name}`;
      const enumValue = (value as string) ?? propDef.enumValues[0] ?? '';
      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={enumId} className="text-xs text-muted-foreground">
            {humanizePropName(propDef.name)}
          </label>
          <Select value={enumValue} onValueChange={onChange}>
            <SelectTrigger id={enumId} size="sm">
              <SelectValue />
            </SelectTrigger>
            {/* PropPanel renders inside a z-[60] PopoverContent (see
                JsxComponentView.tsx); both portal to body, so Select's
                default z-50 loses to the parent Popover. Bump above. */}
            <SelectContent className="z-70">
              {propDef.enumValues.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    case 'number': {
      const numberId = `prop-${propDef.name}`;
      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={numberId} className="text-xs text-muted-foreground">
            {humanizePropName(propDef.name)}
          </label>
          <Input
            id={numberId}
            type="number"
            inputMode="numeric"
            value={value != null ? String(value) : ''}
            onChange={(e) => {
              const raw = e.target.value;
              // Empty string → explicit clear (propagated as `undefined` so
              // optional numeric props can be unset from the UI). Without this
              // branch, backspace-to-empty had no onChange call and React
              // re-rendered from the stored value, visually "reverting" the
              // user's clear. `'-'` stays an early-return because it is a
              // transient state while typing a negative number.
              if (raw === '') {
                onChange(undefined);
                return;
              }
              if (raw === '-') return;
              const num = Number(raw);
              if (!Number.isNaN(num)) onChange(num);
            }}
            onKeyDown={handleDismissKeyDown}
            className="h-7 text-sm"
          />
        </div>
      );
    }

    default:
      return assertUnreachable(propDef);
  }
}

/**
 * Upload affordance rendered below a PropDefString input when the prop
 * declares `accept`. Owns its own in-flight state — the loading spinner +
 * disabled button — so PropControl stays a pure render of the prop value.
 * Clicking the button triggers a programmatic click on the hidden file
 * input; the file input's `onChange` runs the upload and pipes the
 * resolved URL into the prop's `onChange`.
 *
 * Renders as a full-width labeled button ("Upload from computer") rather
 * than an icon-only square — UX research caught users skipping the icon-
 * only affordance entirely and falling back to URL-paste because the
 * picker path read as decoration. The label + width make the path
 * unambiguously clickable.
 */
function PropUploadButton({
  accept,
  onUploaded,
}: {
  accept: readonly string[];
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(',')}
        className="hidden"
        data-prop-upload-input=""
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setUploading(true);
          try {
            await runUpload(file, accept, onUploaded);
          } catch {
            // runUpload owns its own toast; the empty catch keeps cleanup
            // running on the (theoretical) unhandled rejection path.
          }
          setUploading(false);
          // Reset so re-selecting the same file still fires onChange.
          if (inputRef.current) inputRef.current.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        data-prop-upload-trigger=""
        className="h-7 w-full justify-center gap-1.5 px-2 text-xs"
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            <Trans>Uploading</Trans>
          </>
        ) : (
          <>
            <Upload className="size-3.5" aria-hidden="true" />
            <Trans>Upload from computer</Trans>
          </>
        )}
      </Button>
    </>
  );
}
