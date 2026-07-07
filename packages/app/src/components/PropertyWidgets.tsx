// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * Property widgets — controlled inputs for the five frontmatter types.
 *
 * Each widget reads `value` (parsed from the YAML region of `Y.Text('source')`
 * via `bindFrontmatterDoc.current()`) and emits `onCommit(newValue)` on Enter /
 * blur (or click for boolean). The parent (PropertyRow in PropertyPanel)
 * routes commits through `bindFrontmatterDoc.patch()`, which edits the YAML
 * region at the `Pair` level via yaml@2 and replaces the Y.Text byte range
 * under `FORM_WRITE_ORIGIN`. No HTTP round-trip — the change reaches the
 * server via the same WebSocket the editor already uses.
 *
 * Type picker (TypeIconButton) opens a dropdown listing the five widget types;
 * selecting a different type triggers a value coercion + commit so the slot
 * value matches the new shape.
 *
 * List values are flat `string[]`. Widgets present arrays as chip inputs
 * regardless of declared type — value shape wins for rendering.
 */

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

/**
 * Shared widget-shape contract — `keyName` for testids + aria-labels,
 * the current value, and a commit callback that fires on settle (blur,
 * Enter, picker choice). Exported so siblings outside this file
 * (`PageHeaderWidgets.tsx`'s icon + cover widgets) can opt into the
 * same prop shape without duplicating the interface.
 */
export interface CommonWidgetProps<T extends FrontmatterValue> {
  keyName: string;
  value: T;
  onCommit: (next: T) => void;
  /**
   * Optional "submit the whole form" handler for Enter, distinct from
   * `onCommit` (which only settles this field's value). The add-property
   * row wires this so pressing Enter in the value editor commits the new
   * property — instead of merely blurring the input — without the user
   * reaching for the "Add" button. Receives the freshly-typed value so the
   * consumer's commit doesn't race the async `onCommit` state update. When
   * absent (every existing-row editor), Enter keeps its blur-to-settle
   * behavior.
   */
  onSubmit?: (next: T) => void;
}

export function TextWidget({ keyName, value, onCommit, onSubmit }: CommonWidgetProps<string>) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  // Set in onKeyDown(Escape) before blur(); read synchronously in onBlur to
  // skip the commit. setDraft(value) is async — without this flag, the blur
  // handler reads the stale typed draft from the current render closure and
  // commits it before React re-renders with the reverted draft.
  const revertingRef = useRef(false);
  // Link-mode toggle: URL-shaped values render as a clickable chip (the
  // "view"); editing pivots to the textarea below. `isSafeUrl` follows the
  // same scheme allowlist used by page-icon / cover / wiki-link, so any
  // safe http(s) value lights up as a link with zero user opt-in — same
  // posture as how YAML auto-types numbers / dates / booleans from value
  // shape. Plain-text values keep the textarea-as-display behavior.
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Re-sync local draft to incoming `value` when the input is not focused.
  // Without this, a remote concurrent edit (other peer / MCP / file-watcher)
  // is invisible to the widget; on next blur the stale draft would overwrite
  // the remote update — a CRDT divergence at the form surface that the per-
  // key storage layer is supposed to prevent.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);
  // Auto-focus the textarea when entering edit mode from link view. Without
  // this, the user clicks the pencil and the textarea mounts but lands
  // unfocused — they'd have to click into it again to type.
  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
      // Drop the caret at the end so the user is positioned to append /
      // extend rather than replacing the URL by accident.
      const el = textareaRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [isEditing]);

  // Pure-http(s)-URL fast path keeps the original full-replacement
  // anchor chip (label === url). Beyond that, the read view widens
  // to ANY value carrying embedded link syntax — wiki-links,
  // markdown links, or autolinks mixed with prose — so the displayed
  // chip rehydrates the markdown into clickable elements rather than
  // showing raw `[[…]]` / `[text](url)` source. The pencil affordance
  // pivots back to the textarea regardless of which read view fired.
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
          // `dispatchExternalLinkClick` is the shared non-handoff
          // outbound-nav primitive (lib/external-link.ts) — `onClick`
          // covers left-click (with modifiers); `onAuxClick` covers
          // middle-click. Both routes through the Electron
          // shell.openExternal allowlist when the bridge is present,
          // falling through to the anchor's `target="_blank"` default
          // on web. The handoff-dispatch infrastructure under
          // `lib/handoff/` is reserved for the Open-in-Agent flow per
          // its single-entry-point meta-test; this helper is the
          // non-handoff sibling for plain URL navs.
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

  // read view for values that mix prose with embedded link
  // syntax (`[[wikilink]] — note`, `see [doc](./d.md)`, `https://x.y in
  // sentence`). Same layout shell as the URL chip above so the pencil
  // affordance + truncation behavior carry over; the inner element is
  // `PropertyInlineLinks` which tokenizes the value and renders each
  // link kind as an anchor.
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

  // Renders as a `<textarea rows={1}>` with `field-sizing: content` so long
  // values wrap to multiple lines and the box auto-grows to fit instead of
  // horizontally scrolling out of the property column. Enter still commits
  // (the property panel treats text values as single-paragraph).
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
        // Exit the explicit edit-mode flip if the user entered via the
        // pencil affordance — re-render swaps back to the link view when
        // the value still parses as a safe URL.
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
  // See TextWidget — synchronous flag to skip commit on Escape-driven blur.
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

// react-day-picker (+ its locale/formatting weight) is the heaviest dependency
// in the property panel, yet the calendar only renders when the user opens the
// date-picker popover — a rare interaction, and never for non-date fields (most
// frontmatter). Lazy-load it so it splits into its own chunk loaded on demand
// instead of riding in the eager editor bundle. DateWidget itself stays eager so
// the text input renders synchronously (incl. SSR / renderToString); the closed
// Popover doesn't mount its content, so the Suspense boundary only activates on
// open. (date-fns stays eager here — it's small and the input needs it on mount.)
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
  // Same async/sync mismatch as TextWidget / NumberWidget — Escape calls
  // setInputValue(reverted) (async) then blur() (sync). Without this guard,
  // onBlur reads the stale typed inputValue from closure and commitInput()
  // would parse + commit the typed-but-cancelled value.
  const revertingRef = useRef(false);

  // Re-sync input display from external value when not focused (remote edits / commits).
  useEffect(() => {
    if (!focusedRef.current) {
      const next = parseDate(value);
      setInputValue(formatDateForInput(next));
      setMonth(next);
    }
  }, [value]);

  // Returns the committed ISO date on a valid parse (so the Enter handler can
  // forward it to `onSubmit`), or undefined when the input was invalid/empty
  // and reverted to the last committed value.
  function commitInput(): string | undefined {
    const parsed = parseFromInput(inputValue);
    if (parsed) {
      const iso = format(parsed, 'yyyy-MM-dd');
      if (iso !== value) onCommit(iso);
      setInputValue(formatDateForInput(parsed));
      setMonth(parsed);
      return iso;
    }
    // Invalid or empty input — revert to last committed value.
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
          {/* Sized to the calendar's footprint so the popover doesn't resize
              when the lazy chunk resolves. */}
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

// Explicit format strings parsed in local time. `new Date('2026-04-24')` would
// interpret an ISO 8601 date-only string as UTC midnight; `format(d,'yyyy-MM-dd')`
// then formats local — producing off-by-one days in negative-UTC-offset
// timezones. `date-fns/parse` interprets every format in local time, matching
// the rest of the widget's local-time presentation.
const INPUT_PARSE_FORMATS = [
  'MMM d, yyyy', // matches INPUT_DATE_FORMAT — calendar picks round-trip
  'MMMM d, yyyy', // full month name
  'yyyy-MM-dd', // ISO 8601 date
  'M/d/yyyy', // US slashed (Apr 5 = "4/5/2026")
  'MM/dd/yyyy', // zero-padded US
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
  // Inline "rejected last commit" flag — only relevant for `isTagsField`.
  // When the input fails the frontmatter-tag grammar gate, we keep the
  // draft on screen with a red ring + helper text so the author can fix
  // it instead of silently losing their keystrokes.
  const [draftRejected, setDraftRejected] = useState(false);
  const isTagsField = keyName === 'tags';
  function addChip(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (isTagsField && !isValidFrontmatterTagValue(trimmed)) {
      // Reject at the WYSIWYG input boundary; the source-mode editor
      // still allows arbitrary YAML through (and the WYSIWYG render
      // path below flags any invalid entries that arrived that way).
      setDraftRejected(true);
      return;
    }
    // Normalize leading `#` for tags-field commits.
    // `isValidFrontmatterTagValue` strips a leading `#` for paste
    // tolerance (Obsidian-shape input), so `#showcase` passes the
    // gate above — but we must commit the bare form. Without this,
    // `#showcase` would land in YAML as-is, then either (a) render
    // as invalid here on the next paint (`FRONTMATTER_TAG_VALUE_RE`
    // rejects bare `#`), or (b) get silently re-normalized by the
    // disk-side parser on the next round-trip, drifting the
    // displayed value. Strip once, commit canonically.
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
  // The `tags` frontmatter field is the one list whose entries have a
  // navigation semantic — clicking a chip should open the same TagDialog
  // that inline `#tag` clicks open. Generic list values (categories,
  // aliases, or whatever else a user puts in YAML) stay non-interactive.
  // Tag chips render as a primary-tinted pill via inline Tailwind (the
  // wrapper carries bg + hover/active state) so the link button and the
  // remove button live inside one shared pill — intentionally diverging
  // from the global `.tag` CSS class used for inline editor tags, which
  // is a single non-removable element. When a tag chip's value fails the
  // grammar gate (arrived from source mode), it renders with a
  // destructive ring + tooltip explaining the rule so authors can find
  // and clean up the malformed entry without context-switching.
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
              // `max-w-full min-w-0 break-all` constrains a pathologically
              // long single-word tag (`#xxxxxxx…`) to the value cell width
              // and lets the text break mid-string instead of overflowing
              // the column into adjacent layout.
              'inline-flex max-w-full min-w-0 items-center break-all text-1sm gap-0.5 rounded-full py-0.5 pl-2 pr-1.5 transition-colors',
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
                onClick={() => dispatchTagClickEvent(chip)}
                className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                #{chip}
              </button>
            ) : (
              // render embedded link syntax (wikilinks, markdown
              // links, bare URLs) inside the chip as clickable elements
              // instead of raw text. Plain-text chips fast-path through
              // the helper's `hasInlineLinks` short-circuit to a single
              // `<span>`, so the only cost on the common case is one
              // substring probe.
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
        // Tooltip-wrap only invalid tag chips — valid tags + non-tag list
        // values get no extra DOM. The destructive ring on the chip
        // surfaces the invalid state at a glance; the tooltip explains
        // the grammar rule on hover/focus.
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
          // Clear the rejection flag as soon as the author keeps typing
          // — they're correcting; the next commit will re-validate.
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

/**
 * Type → Lucide icon map. Consumed by `TypeIconButton` (the live type-
 * change dropdown) AND by `PlaceholderIdentity` in `FrontmatterRow.tsx`
 * (the static dimmed glyph on placeholder rows like the always-visible
 * `tags` row). The cross-file consumer is the reason for the `export`;
 * if a future change scopes placeholder rendering back into this file,
 * the export can be demoted.
 */
export const TYPE_ICON: Record<FrontmatterType, typeof Type> = {
  text: Type,
  number: Hash,
  boolean: SquareCheck,
  date: CalendarIcon,
  list: List,
  object: Braces,
};

// Module-level constants can't use the `t` macro — `msg` produces lazy
// MessageDescriptors resolved per-render via `useLingui()`'s `t`.
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
  /**
   * Render as a non-interactive type indicator. Used for inherited rows
   * where the cascade owns the type — to change it, the user must
   * materialize the value into the file first, then operate on the
   * file-owned row.
   */
  disabled?: boolean;
  /**
   * Forwarded to `<DropdownMenuContent>`. Consumers that own a different
   * post-close typing target (e.g. AddPropertyRow's name input) call
   * `event.preventDefault()` here and synchronously focus their target.
   */
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
    // Native `disabled` swallows pointer events, so per shadcn's
    // disabled-button pattern we wrap the button in a focusable <span>
    // that the Tooltip can attach to. The button stays truly disabled
    // (correct keyboard + screen-reader semantics); the tooltip surfaces
    // on hover/focus of the wrapper.
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

/**
 * Best-effort coercion when the user changes the declared type. The value-shape
 * always wins for rendering, so coercion mostly matters when a primitive
 * value transitions to a different primitive shape.
 */
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

/**
 * Resolve which widget to render given the underlying value. Value shape wins
 * (a string[] always renders as ListWidget regardless of declared type). For
 * scalar values, fall back to the supplied declared type, which is either an
 * inferred shape or a user-picked override.
 */
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

/**
 * Detect nested object / array-of-object values that the five scalar widgets
 * cannot represent without lossy coercion (an object would `String()` to
 * `'[object Object]'` through the text widget; an array of objects would lose
 * every entry through the scalar `ListWidget`). Plain-object values route to
 * `ObjectWidget` (expandable nested rows); array-of-object values route to
 * `ComplexValueWidget` (read-only preview) until the indexed-item editor
 * lands.
 */
export function isComplexValue(value: FrontmatterValue): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'object' && entry !== null);
  }
  return typeof value === 'object' && value !== null;
}

/** Plain-object discriminator — true only for non-array, non-null `object` values. */
export function isPlainObjectValue(
  value: FrontmatterValue,
): value is { [key: string]: FrontmatterValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Homogeneous array-of-objects discriminator — true only when every element is
 * a plain object. Heterogeneous arrays (mix of scalars + objects) fall through
 * to `ComplexValueWidget` (read-only preview) because the indexed-row model
 * implies every item is the same shape; a mixed array would need a
 * per-item-type picker we don't ship.
 */
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

/**
 * Read-only preview row for nested objects and arrays of objects — the
 * shape categories the five scalar widgets cannot render or commit. The
 * preview surfaces enough structure (top-level keys for objects, item
 * count for arrays) that the user can tell the value is intact while the
 * structured editor is still pending.
 */
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
