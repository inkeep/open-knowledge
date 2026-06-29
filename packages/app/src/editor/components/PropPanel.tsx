
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

function advancedOpenStateKey(descriptorName: string): string {
  return `ok.propPanel.advanced.${descriptorName}`;
}

export function readAdvancedOpenState(descriptorName: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(advancedOpenStateKey(descriptorName)) === 'true';
  } catch {
    return false;
  }
}

export function persistAdvancedOpenState(descriptorName: string, open: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(advancedOpenStateKey(descriptorName), open ? 'true' : 'false');
  } catch {
  }
}

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
  descriptor: JsxComponentDescriptor;
  values: Record<string, unknown>;
  onChange: (propName: string, value: unknown) => void;
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
      return null;
    case 'string': {
      const stringId = `prop-${propDef.name}`;
      const accept = propDef.accept;
      const showUpload = accept !== undefined && accept.length > 0;
      const treatEmptyAsUndefined = !propDef.required && propDef.defaultValue === undefined;

      if (propDef.language) {
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
          }
          setUploading(false);
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
