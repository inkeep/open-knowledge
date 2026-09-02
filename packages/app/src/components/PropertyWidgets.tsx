// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  FRONTMATTER_TAG_GRAMMAR_HINT,
  FRONTMATTER_TAG_VALUE_RE,
  type FrontmatterType,
  type FrontmatterValue,
  isValidFrontmatterTagValue,
} from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { format, parse, parseISO } from 'date-fns';
import {
  Braces,
  Calendar as CalendarIcon,
  Hash,
  List,
  Pencil,
  SquareCheck,
  Type,
  X,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dispatchTagClickEvent } from '@/editor/extensions/tag-click-plugin';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';
import { PropertyInlineLinks } from './PropertyInlineLinks';
import { hasInlineLinks } from './property-inline-link-tokens';

export interface CommonWidgetProps<T extends FrontmatterValue> {
  keyName: string;
  value: T;
  onCommit: (next: T) => void;
  onSubmit?: (next: T) => void;
}

export function TextWidget({ keyName, value, onCommit, onSubmit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [isEditing]);

  const trimmedValue = value.trim();
  const isPureUrl = !isEditing && trimmedValue.length > 0 && /^https?:\/\/\S+$/i.test(trimmedValue);
  const hasMixedLinks = !isEditing && !isPureUrl && hasInlineLinks(value);
  if (isPureUrl) {
    return (
      <div data-testid="link-widget" data-key={keyName} className="group flex items-center gap-1">
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, value)}
          onAuxClick={(e) => {
            if (e.button === 1) dispatchExternalLinkClick(e, value);
          }}
          aria-label={t`Open ${keyName} in browser`}
          title={value}
          className="block min-w-0 flex-1 truncate px-2 py-1 text-sm leading-tight text-azure-blue underline decoration-azure-blue/40 underline-offset-2 hover:decoration-azure-blue focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-blue dark:decoration-sky-blue/40 dark:hover:decoration-sky-blue"
        >
          {value}
        </a>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t`Edit ${keyName}`}
          onClick={() => setIsEditing(true)}
          data-testid="link-widget-edit"
          className="text-muted-foreground/0 hover:text-foreground focus-visible:text-muted-foreground group-hover:text-muted-foreground/60"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  if (hasMixedLinks) {
    return (
      <div
        data-testid="mixed-link-widget"
        data-key={keyName}
        className="group flex items-center gap-1"
      >
        <div
          data-testid="mixed-link-widget-display"
          title={value}
          className="block min-w-0 flex-1 truncate px-2 py-1 text-sm leading-tight"
        >
          <PropertyInlineLinks text={value} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t`Edit ${keyName}`}
          onClick={() => setIsEditing(true)}
          data-testid="mixed-link-widget-edit"
          className="text-muted-foreground/0 hover:text-foreground focus-visible:text-muted-foreground group-hover:text-muted-foreground/60"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      data-testid="text-widget"
      data-key={keyName}
      rows={1}
      value={draft}
      placeholder={t`Empty`}
      aria-label={t`${keyName} value`}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        setIsEditing(false);
        if (revertingRef.current) {
          revertingRef.current = false;
          return;
        }
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          if (draft !== value) onCommit(draft);
          if (onSubmit) onSubmit(draft);
          else (e.currentTarget as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          revertingRef.current = true;
          setDraft(value);
          (e.currentTarget as HTMLTextAreaElement).blur();
        }
      }}
      className="block w-full min-h-7 resize-none field-sizing-content border-transparent bg-transparent px-2 py-1 text-sm leading-tight shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-0 rounded-sm dark:bg-transparent dark:focus-visible:bg-muted"
    />
  );
}

export function NumberWidget({ keyName, value, onCommit, onSubmit }: CommonWidgetProps<number>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string>(String(value));
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);
  return (
    <Input
      data-testid="number-widget"
      data-key={keyName}
      type="number"
      value={draft}
      aria-label={t`${keyName} value`}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (revertingRef.current) {
          revertingRef.current = false;
          setDraft(String(value));
          return;
        }
        const parsed = Number.parseFloat(draft);
        const next = Number.isFinite(parsed) ? parsed : 0;
        if (next !== value) onCommit(next);
        else setDraft(String(value));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (onSubmit) {
            const parsed = Number.parseFloat(draft);
            const next = Number.isFinite(parsed) ? parsed : 0;
            if (next !== value) onCommit(next);
            onSubmit(next);
          } else {
            (e.currentTarget as HTMLInputElement).blur();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          revertingRef.current = true;
          setDraft(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className="h-7 border-transparent bg-transparent dark:bg-transparent px-2 text-sm shadow-none focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0 rounded-sm dark:focus-visible:bg-muted"
    />
  );
}

export function BooleanWidget({ keyName, value, onCommit }: CommonWidgetProps<boolean>) {
  const { t } = useLingui();
  return (
    <div className="flex h-7 items-center px-2">
      <Checkbox
        data-testid="boolean-widget"
        data-key={keyName}
        checked={value}
        onCheckedChange={(next) => onCommit(next === true)}
        aria-label={t`${keyName} value`}
        className="size-5 rounded-full"
      />
    </div>
  );
}

const Calendar = lazy(() =>
  import('@/components/ui/calendar').then((m) => ({ default: m.Calendar })),
);

export function DateWidget({ keyName, value, onCommit, onSubmit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const date = parseDate(value);
  const [inputValue, setInputValue] = useState(formatDateForInput(date));
  const [month, setMonth] = useState<Date | undefined>(date);
  const [open, setOpen] = useState(false);
  const focusedRef = useRef(false);
  const revertingRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      const next = parseDate(value);
      setInputValue(formatDateForInput(next));
      setMonth(next);
    }
  }, [value]);

  function commitInput(): string | undefined {
    const parsed = parseFromInput(inputValue);
    if (parsed) {
      const iso = format(parsed, 'yyyy-MM-dd');
      if (iso !== value) onCommit(iso);
      setInputValue(formatDateForInput(parsed));
      setMonth(parsed);
      return iso;
    }
    setInputValue(formatDateForInput(date));
    setMonth(date);
    return undefined;
  }

  function handleCalendarSelect(selected: Date | undefined) {
    if (!selected) return;
    const iso = format(selected, 'yyyy-MM-dd');
    if (iso !== value) onCommit(iso);
    setInputValue(formatDateForInput(selected));
    setMonth(selected);
    setOpen(false);
  }

  return (
    <div data-testid="date-widget" data-key={keyName} className="relative flex h-7 items-center">
      <Input
        type="text"
        value={inputValue}
        placeholder={t`Empty`}
        aria-label={t`${keyName} value`}
        onChange={(e) => {
          setInputValue(e.target.value);
          const parsed = parseFromInput(e.target.value);
          if (parsed) setMonth(parsed);
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          if (revertingRef.current) {
            revertingRef.current = false;
            return;
          }
          commitInput();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const committed = commitInput();
            if (onSubmit) {
              if (committed !== undefined) onSubmit(committed);
            } else {
              (e.currentTarget as HTMLInputElement).blur();
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            revertingRef.current = true;
            setInputValue(formatDateForInput(date));
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="h-7 border-transparent bg-transparent dark:bg-transparent pr-7 pl-2 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0 rounded-sm dark:focus-visible:bg-muted"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t`Open date picker for ${keyName}`}
            className="absolute right-0 size-6 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CalendarIcon className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="end">
          {}
          <Suspense fallback={<div className="h-[19rem] w-[17rem]" />}>
            <Calendar
              mode="single"
              selected={date}
              month={month}
              onMonthChange={setMonth}
              onSelect={handleCalendarSelect}
              captionLayout="dropdown"
            />
          </Suspense>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const INPUT_DATE_FORMAT = 'MMM d, yyyy';

function parseDate(value: string): Date | undefined {
  if (!value) return undefined;
  const d = parseISO(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function formatDateForInput(date: Date | undefined): string {
  return date ? format(date, INPUT_DATE_FORMAT) : '';
}

const INPUT_PARSE_FORMATS = [
  'MMM d, yyyy',
  'MMMM d, yyyy',
  'yyyy-MM-dd',
  'M/d/yyyy',
  'MM/dd/yyyy',
] as const;

export function parseFromInput(input: string): Date | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const reference = new Date();
  for (const fmt of INPUT_PARSE_FORMATS) {
    const d = parse(trimmed, fmt, reference);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

export function ListWidget({ keyName, value, onCommit }: CommonWidgetProps<string[]>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState('');
  const [draftRejected, setDraftRejected] = useState(false);
  const isTagsField = keyName === 'tags';
  function addChip(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (isTagsField && !isValidFrontmatterTagValue(trimmed)) {
      setDraftRejected(true);
      return;
    }
    const normalized = isTagsField && trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    setDraftRejected(false);
    onCommit([...value, normalized]);
    setDraft('');
  }
  function removeChip(index: number) {
    const next = value.slice();
    next.splice(index, 1);
    onCommit(next);
  }
  return (
    <div
      data-testid="list-widget"
      data-key={keyName}
      className="flex min-h-7 w-full min-w-0 flex-wrap items-center gap-1 rounded-md px-2 py-1 focus-within:bg-background"
    >
      {value.map((chip, i) => {
        const renderAsTag = isTagsField && FRONTMATTER_TAG_VALUE_RE.test(chip);
        const renderAsInvalidTag = isTagsField && !renderAsTag;
        const chipBody = (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are positional; user reorders via add/remove
            key={`${i}-${chip}`}
            data-testid="list-chip"
            data-index={i}
            data-tag-invalid={renderAsInvalidTag ? 'true' : undefined}
            className={cn(
              'inline-flex max-w-full min-w-0 items-center break-all text-1sm gap-0.5 rounded-xl py-0.5 pl-2 pr-1.5 transition-colors',
              renderAsTag &&
                'bg-primary/10 font-medium text-primary has-[button[data-tag]:hover]:bg-primary/20 has-[button[data-tag]:active]:bg-primary/25',
              renderAsInvalidTag &&
                'bg-destructive/10 font-medium text-destructive ring-1 ring-destructive/40',
              !renderAsTag && !renderAsInvalidTag && 'bg-muted',
            )}
          >
            {renderAsTag ? (
              <button
                type="button"
                data-tag={chip}
                aria-label={t`Open documents tagged #${chip}`}
                dir="auto"
                onClick={() => dispatchTagClickEvent(chip)}
                className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                #{chip}
              </button>
            ) : (
              <PropertyInlineLinks text={chip} />
            )}
            <button
              type="button"
              aria-label={t`Remove ${chip}`}
              onClick={() => removeChip(i)}
              className={cn(
                'inline-flex items-center justify-center rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                renderAsTag && 'text-primary opacity-70 hover:text-primary hover:opacity-100',
                renderAsInvalidTag &&
                  'text-destructive opacity-70 hover:text-destructive hover:opacity-100',
                !renderAsTag &&
                  !renderAsInvalidTag &&
                  'text-muted-foreground hover:text-foreground',
              )}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        );
        if (!renderAsInvalidTag) return chipBody;
        return (
          <Tooltip
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are positional; user reorders via add/remove
            key={`${i}-${chip}`}
          >
            <TooltipTrigger asChild>{chipBody}</TooltipTrigger>
            <TooltipContent>{FRONTMATTER_TAG_GRAMMAR_HINT}</TooltipContent>
          </Tooltip>
        );
      })}
      <input
        data-testid="list-chip-input"
        data-tag-invalid={draftRejected ? 'true' : undefined}
        type="text"
        value={draft}
        placeholder={value.length === 0 ? t`Empty` : ''}
        aria-label={t`${keyName} value`}
        aria-invalid={draftRejected ? 'true' : undefined}
        aria-describedby={draftRejected ? `${keyName}-tag-grammar` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (draftRejected) setDraftRejected(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addChip(draft);
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            e.preventDefault();
            removeChip(value.length - 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft('');
            setDraftRejected(false);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={() => {
          if (draft) addChip(draft);
        }}
        className={cn(
          'min-w-16 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60',
          draftRejected && 'text-destructive placeholder:text-destructive/60',
        )}
      />
      {draftRejected && (
        <span
          id={`${keyName}-tag-grammar`}
          role="alert"
          data-testid="list-chip-input-error"
          className="w-full px-2 pt-0.5 text-xs text-destructive"
        >
          {FRONTMATTER_TAG_GRAMMAR_HINT}
        </span>
      )}
    </div>
  );
}

export const TYPE_ICON: Record<FrontmatterType, typeof Type> = {
  text: Type,
  number: Hash,
  boolean: SquareCheck,
  date: CalendarIcon,
  list: List,
  object: Braces,
};

const TYPE_LABEL: Record<FrontmatterType, MessageDescriptor> = {
  text: msg`Text`,
  number: msg`Number`,
  boolean: msg`Checkbox`,
  date: msg`Date`,
  list: msg`List`,
  object: msg`Object`,
};

export const DEFAULT_VALUE_FOR_TYPE: Record<FrontmatterType, FrontmatterValue> = {
  text: '',
  number: 0,
  boolean: false,
  date: '',
  list: [],
  object: {},
};

interface TypeIconButtonProps {
  keyName: string;
  type: FrontmatterType;
  onChangeType: (next: FrontmatterType) => void;
  disabled?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}

export function TypeIconButton({
  keyName,
  type,
  onChangeType,
  disabled = false,
  onCloseAutoFocus,
}: TypeIconButtonProps) {
  const { t } = useLingui();
  const Icon = TYPE_ICON[type];
  const typeLabel = t(TYPE_LABEL[type]);
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: shadcn's tooltip-on-disabled-button pattern requires a focusable <span> wrapper so keyboard users can reach the tooltip — the inner <button disabled> is removed from tab order. https://ui.shadcn.com/docs/components/radix/tooltip#disabled-button */}
          <span tabIndex={0} className="inline-flex">
            <button
              type="button"
              disabled
              data-testid="type-icon-button"
              data-key={keyName}
              data-type={type}
              aria-label={t`${keyName} type: ${typeLabel} (inherited from folder properties; not editable here)`}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground disabled:cursor-default"
            >
              <Icon className="size-3.5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <Trans>Inherited — set a value here to replace it.</Trans>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="type-icon-button"
        data-key={keyName}
        data-type={type}
        aria-label={t`${keyName} type: ${typeLabel}. Click to change.`}
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-testid="type-picker-menu"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuRadioGroup
          value={type}
          onValueChange={(next) => onChangeType(next as FrontmatterType)}
        >
          {(Object.keys(TYPE_ICON) as FrontmatterType[])
            .filter((typeKey) => typeKey !== 'object')
            .map((typeKey) => {
              const ItemIcon = TYPE_ICON[typeKey];
              return (
                <DropdownMenuRadioItem
                  key={typeKey}
                  value={typeKey}
                  data-testid="type-picker-item"
                  data-type={typeKey}
                >
                  <ItemIcon className="size-3.5 text-muted-foreground" />
                  <span>{t(TYPE_LABEL[typeKey])}</span>
                </DropdownMenuRadioItem>
              );
            })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function coerceValue(value: FrontmatterValue, target: FrontmatterType): FrontmatterValue {
  switch (target) {
    case 'text': {
      if (Array.isArray(value)) return value.join(', ');
      if (typeof value === 'object' && value !== null) return '';
      return String(value);
    }
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'object' && value !== null) return 0;
      const head = Array.isArray(value) ? value[0] : value;
      const candidate = typeof head === 'string' ? head : head == null ? '' : String(head);
      const parsed = Number.parseFloat(candidate);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'object' && value !== null) return false;
      const head = Array.isArray(value) ? value[0] : value;
      const candidate = typeof head === 'string' ? head : head == null ? '' : String(head);
      return candidate.toLowerCase() === 'true';
    }
    case 'date': {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      const today = new Date().toISOString().slice(0, 10);
      return today;
    }
    case 'list': {
      if (Array.isArray(value)) return value;
      if (typeof value === 'object' && value !== null) return [];
      const s = String(value);
      return s ? [s] : [];
    }
    case 'object': {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
      return {};
    }
  }
}

export function resolveWidgetType(
  value: FrontmatterValue,
  declared: FrontmatterType,
): FrontmatterType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object' && value !== null) return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (declared === 'list' || declared === 'object') return 'text';
  return declared;
}

export function isComplexValue(value: FrontmatterValue): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'object' && entry !== null);
  }
  return typeof value === 'object' && value !== null;
}

export function isPlainObjectValue(
  value: FrontmatterValue,
): value is { [key: string]: FrontmatterValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArrayOfObjectsValue(
  value: FrontmatterValue,
): value is Array<{ [key: string]: FrontmatterValue }> {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((entry) => isPlainObjectValue(entry as FrontmatterValue));
}

interface ComplexValueWidgetProps {
  keyName: string;
  value: FrontmatterValue;
}

export function ComplexValueWidget({ keyName, value }: ComplexValueWidgetProps) {
  const summary = summarizeComplexValue(value);
  const isArray = Array.isArray(value);
  return (
    <div
      data-testid="complex-value-widget"
      data-key={keyName}
      data-shape={isArray ? 'array' : 'object'}
      className="flex min-h-7 w-full min-w-0 items-center px-2 py-1"
    >
      <span className="truncate font-mono text-xs text-muted-foreground" title={summary}>
        {summary}
      </span>
      <span className="ml-2 shrink-0 text-2xs text-muted-foreground/70">
        <Trans>(read-only — edit in source mode for now)</Trans>
      </span>
    </div>
  );
}

const COMPLEX_PREVIEW_KEY_LIMIT = 4;

function summarizeComplexValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return value.length === 1 ? '[1 item]' : `[${value.length} items]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const head = keys.slice(0, COMPLEX_PREVIEW_KEY_LIMIT).join(', ');
    const more = keys.length > COMPLEX_PREVIEW_KEY_LIMIT ? `, …` : '';
    return `{${head}${more}}`;
  }
  return String(value);
}
