// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type FrontmatterType,
  type FrontmatterValue,
  isFrontmatterValueEmpty,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, GripVertical, Trash2, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import {
  type AddPropertyFieldSuggestion,
  AddPropertyNameField,
} from '@/components/AddPropertyNameField';
import { ArrayOfObjectsWidget } from '@/components/ArrayOfObjectsWidget';
import { ObjectWidget } from '@/components/ObjectWidget';
import { PageCoverWidget, PageIconWidget } from '@/components/PageHeaderWidgets';
import {
  BooleanWidget,
  ComplexValueWidget,
  DateWidget,
  isArrayOfObjectsValue,
  isComplexValue,
  isPlainObjectValue,
  ListWidget,
  NumberWidget,
  TextWidget,
  TYPE_ICON,
  TypeIconButton,
} from '@/components/PropertyWidgets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface AddDraft {
  name: string;
  type: FrontmatterType;
  value: FrontmatterValue;
  error: string | null;
}

const ADD_ROW_PATH: ReadonlyArray<string | number> = ['__add__'] as const;

export interface RenameDraft {
  key: string;
  draft: string;
  error: string | null;
}

interface FrontmatterRowRenameApi {
  state: RenameDraft | null;
  onBegin: () => void;
  onChangeDraft: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

interface FrontmatterRowProps {
  keyName: string;
  value: FrontmatterValue;
  declared: FrontmatterType;
  enumConstraint?: { values: string[]; multi: boolean };
  error?: string | null;
  resetCounter?: number;
  sortableId?: string;
  rename?: FrontmatterRowRenameApi;
  isDuplicate?: boolean;
  badge?: ReactNode;
  isPlaceholder?: boolean;
  path?: ReadonlyArray<string | number>;
  onCommit: (next: FrontmatterValue) => void;
  onChangeType: (next: FrontmatterType) => void;
  onRemove?: () => void;
  actionSlot?: ReactNode;
}

export function FrontmatterRow({
  keyName,
  value,
  declared,
  enumConstraint,
  error,
  resetCounter = 0,
  sortableId,
  rename,
  isDuplicate = false,
  badge,
  isPlaceholder = false,
  path,
  onCommit,
  onChangeType,
  onRemove,
  actionSlot,
}: FrontmatterRowProps) {
  const { t } = useLingui();
  const isComplex = isComplexValue(value);
  const rowPath: ReadonlyArray<string | number> = path ?? [keyName];
  return (
    <SortableShell
      sortableId={sortableId}
      keyName={keyName}
      declared={declared}
      error={error}
      isDuplicate={isDuplicate}
      isPlaceholder={isPlaceholder}
      isComplex={isComplex}
    >
      {(dragHandle) => (
        <>
          {}
          <div className="flex items-start gap-1 @max-[26rem]/prow:flex-wrap">
            {dragHandle}
            <div className="flex items-center gap-1" data-testid="property-row-identity">
              {isPlaceholder ? (
                <PlaceholderIdentity keyName={keyName} type={declared} />
              ) : (
                <>
                  {isComplex ? (
                    <ComplexValueTypeIcon keyName={keyName} type={declared} />
                  ) : (
                    <TypeIconButton keyName={keyName} type={declared} onChangeType={onChangeType} />
                  )}
                  <div className="w-32 shrink-0 @max-[26rem]/prow:w-auto">
                    {rename?.state ? (
                      <RenameInput
                        keyName={keyName}
                        draft={rename.state.draft}
                        error={rename.state.error}
                        onChangeDraft={rename.onChangeDraft}
                        onCommit={rename.onCommit}
                        onCancel={rename.onCancel}
                      />
                    ) : (
                      <KeyNameButton
                        keyName={keyName}
                        onBegin={rename?.onBegin}
                        disabled={!rename}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
            {isDuplicate ? (
              <span
                data-testid="property-duplicate-marker"
                data-key={keyName}
                title={t`Duplicate name "${keyName}"`}
                className="flex size-4 items-center justify-center text-amber-600"
              >
                <AlertTriangle className="size-3.5" />
              </span>
            ) : null}
            <div className="min-w-0 flex-1 @max-[26rem]/prow:order-last @max-[26rem]/prow:mt-0.5 @max-[26rem]/prow:basis-full @max-[26rem]/prow:pl-[3.25rem]">
              {enumConstraint && !isComplex && !enumConstraint.multi ? (
                <EnumSelectWidget
                  key={`widget-${resetCounter}`}
                  keyName={keyName}
                  value={value}
                  values={enumConstraint.values}
                  onCommit={onCommit}
                />
              ) : enumConstraint && !isComplex && enumConstraint.multi ? (
                <EnumMultiSelectWidget
                  key={`widget-${resetCounter}`}
                  keyName={keyName}
                  value={value}
                  values={enumConstraint.values}
                  onCommit={onCommit}
                />
              ) : (
                <Widget
                  key={`widget-${resetCounter}`}
                  keyName={keyName}
                  value={value}
                  widgetType={declared}
                  path={rowPath}
                  onCommit={onCommit}
                />
              )}
            </div>
            {badge ? <div className="shrink-0 min-h-7 flex items-center">{badge}</div> : null}
            {actionSlot}
            {onRemove ? (
              <Button
                type="button"
                data-testid="property-remove-button"
                data-key={keyName}
                aria-label={t`Remove ${keyName}`}
                onClick={onRemove}
                variant="ghost"
                size="icon-sm"
                className="flex shrink-0 items-center justify-center rounded text-muted-foreground/0 hover:bg-muted hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
              >
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </div>
          {error ? (
            <div
              role="alert"
              data-testid="property-error"
              data-key={keyName}
              className="pl-9 text-[10px] text-destructive @max-[26rem]/prow:pl-[3.25rem]"
            >
              {error}
            </div>
          ) : null}
        </>
      )}
    </SortableShell>
  );
}

function SortableShell({
  sortableId,
  keyName,
  declared,
  error,
  isDuplicate,
  isPlaceholder,
  isComplex,
  children,
}: {
  sortableId: string | undefined;
  keyName: string;
  declared: FrontmatterType;
  error?: string | null;
  isDuplicate: boolean;
  isPlaceholder: boolean;
  isComplex: boolean;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  if (sortableId) {
    return (
      <SortableRowBody
        sortableId={sortableId}
        keyName={keyName}
        declared={declared}
        error={error}
        isDuplicate={isDuplicate}
        isComplex={isComplex}
      >
        {children}
      </SortableRowBody>
    );
  }
  const dragHandleSlot = isPlaceholder ? <span aria-hidden className="h-7 w-4 shrink-0" /> : null;
  return (
    <div
      className="group @container/prow py-0.5"
      data-testid="property-row"
      data-key={keyName}
      data-widget-type={declared}
      data-error={error ?? undefined}
      data-duplicate={isDuplicate || undefined}
      data-complex-value={isComplex || undefined}
    >
      {children(dragHandleSlot)}
    </div>
  );
}

function SortableRowBody({
  sortableId,
  keyName,
  declared,
  error,
  isDuplicate,
  isComplex,
  children,
}: {
  sortableId: string;
  keyName: string;
  declared: FrontmatterType;
  error?: string | null;
  isDuplicate: boolean;
  isComplex: boolean;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { t } = useLingui();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 1 : undefined,
  };
  const dragHandle = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="property-drag-handle"
      data-key={keyName}
      aria-label={t`Drag ${keyName} to reorder`}
      {...attributes}
      {...listeners}
      className="h-7 w-4 shrink-0 cursor-grab touch-none px-0 text-muted-foreground/0 hover:text-foreground focus-visible:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover:text-muted-foreground/60"
    >
      <GripVertical className="size-3.5" />
    </Button>
  );
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group @container/prow py-0.5"
      data-testid="property-row"
      data-key={keyName}
      data-widget-type={declared}
      data-error={error ?? undefined}
      data-duplicate={isDuplicate || undefined}
      data-complex-value={isComplex || undefined}
      data-dragging={isDragging || undefined}
    >
      {children(dragHandle)}
    </div>
  );
}

function ComplexValueTypeIcon({ keyName, type }: { keyName: string; type: FrontmatterType }) {
  const { t } = useLingui();
  const Icon = TYPE_ICON[type];
  return (
    <span
      role="img"
      data-testid="type-icon-static"
      data-key={keyName}
      data-type={type}
      aria-label={t`${keyName} type: complex value (nested; read-only)`}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

interface RenameInputProps {
  keyName: string;
  draft: string;
  error: string | null;
  onChangeDraft: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function RenameInput({
  keyName,
  draft,
  error,
  onChangeDraft,
  onCommit,
  onCancel,
}: RenameInputProps) {
  const { t } = useLingui();
  const errorId = error ? `property-rename-error-${keyName}` : undefined;
  return (
    <div>
      <Input
        data-testid="property-name-rename-input"
        data-key={keyName}
        type="text"
        value={draft}
        autoFocus
        aria-label={t`Rename ${keyName}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        onChange={(e) => onChangeDraft(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-7 border-transparent bg-transparent dark:bg-transparent px-2 text-sm shadow-none focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0 rounded-sm dark:focus-visible:bg-muted"
      />
      {error ? (
        <div
          id={errorId}
          data-testid="property-name-rename-error"
          className="text-[10px] text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

function KeyNameButton({
  keyName,
  onBegin,
  disabled,
}: {
  keyName: string;
  onBegin: (() => void) | undefined;
  disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="property-name-button"
      data-key={keyName}
      onClick={onBegin}
      disabled={disabled}
      className="block h-7 w-full truncate px-2 py-0.5 text-left text-sm rounded-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-100 disabled:cursor-default"
    >
      {keyName}
    </Button>
  );
}

function PlaceholderIdentity({ keyName, type }: { keyName: string; type: FrontmatterType }) {
  const Icon = TYPE_ICON[type];
  return (
    <>
      <span
        aria-hidden
        data-testid="property-placeholder-icon"
        data-key={keyName}
        className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground/60"
      >
        <Icon className="size-3.5" />
      </span>
      <div className="w-32 shrink-0 @max-[26rem]/prow:w-auto">
        <span
          data-testid="property-placeholder-name"
          data-key={keyName}
          className="block h-7 truncate px-2 py-1.5 text-sm leading-tight text-muted-foreground/60"
        >
          {keyName}
        </span>
      </div>
    </>
  );
}

interface AddPropertyRowProps {
  draft: AddDraft;
  onChangeName: (next: string) => void;
  onChangeType: (next: FrontmatterType) => void;
  onChangeValue: (next: FrontmatterValue) => void;
  onCommit: (valueOverride?: FrontmatterValue) => void;
  onCancel: () => void;
  rowId?: string;
  autoFocus?: 'name' | 'value' | 'none';
  enumConstraint?: { values: string[]; multi: boolean };
  fieldSuggestions?: readonly AddPropertyFieldSuggestion[];
  onPickField?: (suggestion: AddPropertyFieldSuggestion) => void;
}

export function AddPropertyRow({
  draft,
  onChangeName,
  onChangeType,
  onChangeValue,
  onCommit,
  onCancel,
  rowId = '__add__',
  autoFocus = 'name',
  enumConstraint,
  fieldSuggestions = [],
  onPickField,
}: AddPropertyRowProps) {
  const { t } = useLingui();
  const errorId = draft.error ? `add-property-error-${rowId}` : undefined;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const valueCellRef = useRef<HTMLDivElement>(null);

  const wantsValueFocus = autoFocus === 'value';
  const valueFocusClaimed = useRef(false);
  useEffect(() => {
    if (!wantsValueFocus || valueFocusClaimed.current) return;
    valueFocusClaimed.current = true;
    const focusable = valueCellRef.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [wantsValueFocus]);

  function handlePickField(suggestion: AddPropertyFieldSuggestion): void {
    if (onPickField) {
      onPickField(suggestion);
      return;
    }
    onChangeName(suggestion.name);
    onChangeType(suggestion.type);
  }
  const isAddDisabled = draft.name.trim() === '' || isFrontmatterValueEmpty(draft.value);

  return (
    <div
      className="mt-1 rounded border border-dashed bg-background/40 p-1 @container/prow"
      data-testid="add-property-row"
      data-key={rowId}
    >
      <div className="flex items-start gap-1 @max-[26rem]/prow:flex-wrap">
        <TypeIconButton
          keyName="__add__"
          type={draft.type}
          onChangeType={onChangeType}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            nameInputRef.current?.focus();
          }}
        />
        <AddPropertyNameField
          rowId={rowId}
          value={draft.name}
          suggestions={fieldSuggestions}
          inputRef={nameInputRef}
          autoFocus={autoFocus === 'name'}
          error={draft.error !== null}
          errorId={errorId}
          onChange={onChangeName}
          onPick={handlePickField}
          onCommit={onCommit}
          onCancel={onCancel}
        />
        <div
          ref={valueCellRef}
          className="min-w-0 flex-1 @max-[26rem]/prow:order-last @max-[26rem]/prow:mt-0.5 @max-[26rem]/prow:basis-full @max-[26rem]/prow:pl-[2rem]"
        >
          {}
          {enumConstraint && !enumConstraint.multi ? (
            <EnumSelectWidget
              keyName="__add__"
              value={draft.value}
              values={enumConstraint.values}
              onCommit={onChangeValue}
            />
          ) : enumConstraint ? (
            <EnumMultiSelectWidget
              keyName="__add__"
              value={draft.value}
              values={enumConstraint.values}
              onCommit={onChangeValue}
            />
          ) : (
            <Widget
              keyName="__add__"
              value={draft.value}
              widgetType={draft.type}
              path={ADD_ROW_PATH}
              onCommit={onChangeValue}
              onSubmit={onCommit}
            />
          )}
        </div>

        <Button
          type="button"
          data-testid="add-property-commit"
          onClick={() => onCommit()}
          disabled={isAddDisabled}
          size="sm"
          className="rounded bg-primary text-xs text-primary-foreground hover:bg-primary/90"
        >
          <Trans>Add</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="add-property-cancel"
          onClick={onCancel}
          aria-label={t`Cancel`}
          className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {draft.error ? (
        <div
          id={errorId}
          role="alert"
          data-testid="add-property-error"
          className="mt-0.5 pl-7 text-[10px] text-destructive"
        >
          {draft.error}
        </div>
      ) : null}
    </div>
  );
}

interface WidgetProps {
  keyName: string;
  value: FrontmatterValue;
  widgetType: FrontmatterType;
  path: ReadonlyArray<string | number>;
  onCommit: (next: FrontmatterValue) => void;
  onSubmit?: (next: FrontmatterValue) => void;
}

function Widget({ keyName, value, widgetType, path, onCommit, onSubmit }: WidgetProps) {
  if (keyName === 'icon') {
    const str = typeof value === 'string' ? value : '';
    return <PageIconWidget keyName={keyName} value={str} onCommit={onCommit} />;
  }
  if (keyName === 'cover' || keyName === 'banner') {
    const str = typeof value === 'string' ? value : '';
    return <PageCoverWidget keyName={keyName} value={str} onCommit={onCommit} />;
  }
  if (isPlainObjectValue(value)) {
    return <ObjectWidget keyName={keyName} value={value} path={path} depth={path.length - 1} />;
  }
  if (isArrayOfObjectsValue(value)) {
    return (
      <ArrayOfObjectsWidget keyName={keyName} value={value} path={path} depth={path.length - 1} />
    );
  }
  if (isComplexValue(value)) {
    return <ComplexValueWidget keyName={keyName} value={value} />;
  }
  if (widgetType === 'list') {
    const arr = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return <ListWidget keyName={keyName} value={arr} onCommit={onCommit} />;
  }
  if (widgetType === 'boolean') {
    const bool = typeof value === 'boolean' ? value : false;
    return <BooleanWidget keyName={keyName} value={bool} onCommit={onCommit} />;
  }
  if (widgetType === 'number') {
    const num = typeof value === 'number' ? value : 0;
    return <NumberWidget keyName={keyName} value={num} onCommit={onCommit} onSubmit={onSubmit} />;
  }
  if (widgetType === 'date') {
    const str = typeof value === 'string' ? value : '';
    return <DateWidget keyName={keyName} value={str} onCommit={onCommit} onSubmit={onSubmit} />;
  }
  const str =
    typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : String(value);
  return <TextWidget keyName={keyName} value={str} onCommit={onCommit} onSubmit={onSubmit} />;
}

export function InheritedBadge({
  source,
  target = 'frontmatter.yml',
}: {
  source: string;
  target?: string;
}) {
  const { t } = useLingui();
  const path = source === '' ? `.ok/${target}` : `${source}/.ok/${target}`;
  return (
    <Badge
      variant="gray"
      data-testid="property-inherited-badge"
      title={t`Inherited from ${path}`}
      className="text-2xs"
    >
      <Trans>inherited</Trans>
    </Badge>
  );
}

function EnumSelectWidget({
  keyName,
  value,
  values,
  onCommit,
}: {
  keyName: string;
  value: FrontmatterValue;
  values: string[];
  onCommit: (next: FrontmatterValue) => void;
}) {
  const { t } = useLingui();
  const current = typeof value === 'string' ? value : '';
  const options = current !== '' && !values.includes(current) ? [current, ...values] : values;
  return (
    <Select value={current} onValueChange={(next) => onCommit(next)}>
      <SelectTrigger
        className="h-7 w-full"
        aria-label={t`Value for ${keyName}`}
        data-testid="property-enum-select"
        data-key={keyName}
      >
        <SelectValue placeholder={t`Select a value`} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EnumMultiSelectWidget({
  keyName,
  value,
  values,
  onCommit,
}: {
  keyName: string;
  value: FrontmatterValue;
  values: string[];
  onCommit: (next: FrontmatterValue) => void;
}) {
  const { t } = useLingui();
  const selected = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const extras = selected.filter((entry) => !values.includes(entry));
  const toggle = (option: string) => {
    const next = selected.includes(option)
      ? selected.filter((entry) => entry !== option)
      : [...selected, option];
    onCommit(next);
  };
  return (
    <fieldset
      className="m-0 flex min-h-7 flex-wrap items-center gap-1 border-0 p-0"
      aria-label={t`Values for ${keyName}`}
      data-testid="property-enum-multi"
      data-key={keyName}
    >
      {[...values, ...extras].map((option) => {
        const on = selected.includes(option);
        return (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={on ? 'secondary' : 'outline'}
            aria-pressed={on}
            className="h-6 px-2 text-xs"
            onClick={() => toggle(option)}
            data-testid={`property-enum-option-${option}`}
          >
            {option}
          </Button>
        );
      })}
    </fieldset>
  );
}
