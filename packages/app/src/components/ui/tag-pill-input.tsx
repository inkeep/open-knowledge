'use client';

import {
  FRONTMATTER_TAG_GRAMMAR_HINT,
  isValidFrontmatterTagValue,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { XIcon } from 'lucide-react';
import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface TagPillInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  onBlur?: () => void;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  disabled?: boolean;
  grammar?: 'frontmatter-tag' | 'free-text';
  entryProblems?: ReadonlyMap<string, string>;
  ref?: Ref<HTMLInputElement>;
}

function TagPillInput({
  value,
  onChange,
  onBlur,
  placeholder,
  id,
  disabled,
  grammar = 'frontmatter-tag',
  entryProblems,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ref,
}: TagPillInputProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState('');
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [highlightedEntry, setHighlightedEntry] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const attachInput = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  const [draftRejected, setDraftRejected] = useState(false);
  const fallbackId = useId();
  const grammarHintId = `${id ?? fallbackId}-grammar-hint`;
  const pillIdBase = `${id ?? fallbackId}-pill`;
  const resolvedPlaceholder = placeholder ?? t`Add tag`;

  const tagGrammar = grammar === 'frontmatter-tag';

  const clearDraft = () => {
    setDraft('');
    setDraftRejected(false);
    setEditingEntry(null);
  };

  const addTag = (raw: string): boolean => {
    const tag = raw.trim();
    const editIndex = editingEntry === null ? -1 : value.indexOf(editingEntry);
    if (!tag) {
      if (editIndex !== -1) onChange(value.filter((_, i) => i !== editIndex));
      if (editingEntry !== null) clearDraft();
      return true;
    }
    if (tagGrammar && !isValidFrontmatterTagValue(tag)) {
      setDraftRejected(true);
      return false;
    }
    const normalized = tagGrammar && tag.startsWith('#') ? tag.slice(1) : tag;
    const duplicateAt = value.indexOf(normalized);
    if (editIndex === -1) {
      if (duplicateAt === -1) onChange([...value, normalized]);
      clearDraft();
      return true;
    }
    const next = value.map((entry, i) => (i === editIndex ? normalized : entry));
    onChange(
      duplicateAt === -1 || duplicateAt === editIndex
        ? next
        : next.filter((_, i) => i !== editIndex),
    );
    clearDraft();
    return true;
  };

  const removeAt = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  const beginEdit = (entry: string) => {
    if (disabled) return;
    if (draft.trim() !== '') addTag(draft);
    setDraft(entry);
    setDraftRejected(false);
    setHighlightedEntry(null);
    setEditingEntry(entry);
  };

  const highlightedIndex = highlightedEntry === null ? -1 : value.indexOf(highlightedEntry);
  const highlightAt = (index: number | null) => {
    setHighlightedEntry(index === null ? null : (value[index] ?? null));
  };

  useEffect(() => {
    if (editingEntry === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingEntry]);

  return (
    <div
      data-slot="tag-pill-input"
      aria-invalid={draftRejected ? 'true' : ariaInvalid}
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        'dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      {value.map((tag, i) => {
        if (tag === editingEntry) return null;
        const invalid = tagGrammar && !isValidFrontmatterTagValue(tag);
        const problem = entryProblems?.get(tag);
        const flagged = invalid || problem !== undefined;
        const hint = problem ?? (invalid ? FRONTMATTER_TAG_GRAMMAR_HINT : undefined);
        const highlighted = tag === highlightedEntry;
        const badge = (
          <Badge
            key={tag}
            id={`${pillIdBase}-${i}`}
            variant={flagged ? 'destructive' : 'secondary'}
            data-tag-invalid={invalid ? 'true' : undefined}
            data-tag-problem={problem !== undefined ? 'true' : undefined}
            data-highlighted={highlighted ? 'true' : undefined}
            className={cn(
              'gap-1 pl-2 pr-1 normal-case',
              flagged && 'ring-1 ring-destructive/40',
              highlighted && 'ring-2 ring-ring/70',
            )}
          >
            {}
            <button
              type="button"
              tabIndex={-1}
              className="cursor-pointer rounded-sm font-mono"
              onDoubleClick={() => beginEdit(tag)}
              disabled={disabled}
              aria-label={t`Edit ${tag}`}
              title={hint === undefined ? t`Double-click to edit` : undefined}
            >
              {tag}
            </button>
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label={t`Remove ${tag}`}
              className="rounded-sm p-0.5 hover:bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              disabled={disabled}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        );
        if (hint === undefined) return badge;
        return (
          <Tooltip key={tag}>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        );
      })}
      <input
        id={id}
        ref={attachInput}
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (draftRejected) setDraftRejected(false);
          if (highlightedEntry !== null) setHighlightedEntry(null);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0;
          if (editingEntry === null && value.length > 0) {
            if (e.key === 'ArrowLeft' && (highlightedIndex !== -1 || caretAtStart)) {
              e.preventDefault();
              highlightAt(
                highlightedIndex === -1 ? value.length - 1 : Math.max(0, highlightedIndex - 1),
              );
              return;
            }
            if (e.key === 'ArrowRight' && highlightedIndex !== -1) {
              e.preventDefault();
              highlightAt(highlightedIndex === value.length - 1 ? null : highlightedIndex + 1);
              return;
            }
            if ((e.key === 'Home' || e.key === 'End') && highlightedIndex !== -1) {
              e.preventDefault();
              highlightAt(e.key === 'Home' ? 0 : value.length - 1);
              return;
            }
          }
          if (highlightedIndex !== -1 && editingEntry === null) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const entry = value[highlightedIndex];
              if (entry !== undefined) beginEdit(entry);
              return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              const before = value[highlightedIndex - 1] ?? null;
              const after = value[highlightedIndex + 1] ?? null;
              removeAt(highlightedIndex);
              setHighlightedEntry(e.key === 'Backspace' ? (before ?? after) : (after ?? before));
              return;
            }
          }
          if (e.key === 'Enter') {
            if (draft.trim() || editingEntry !== null) {
              e.preventDefault();
              addTag(draft);
            }
          } else if (e.key === ',') {
            e.preventDefault();
            if (draft.trim()) {
              addTag(draft);
            }
          } else if (e.key === 'Tab') {
            if (draft.trim()) {
              e.preventDefault();
              addTag(draft);
            }
          } else if (
            e.key === 'Backspace' &&
            draft === '' &&
            value.length > 0 &&
            editingEntry === null
          ) {
            e.preventDefault();
            removeAt(value.length - 1);
          } else if (e.key === 'Escape') {
            if (editingEntry !== null || draftRejected) {
              e.preventDefault();
              clearDraft();
              setHighlightedEntry(null);
            } else if (highlightedIndex !== -1) {
              e.preventDefault();
              setHighlightedEntry(null);
            }
          }
        }}
        onBlur={() => {
          if (draft.trim() || editingEntry !== null) {
            if (!addTag(draft) && editingEntry !== null) clearDraft();
          }
          setHighlightedEntry(null);
          onBlur?.();
        }}
        placeholder={value.length === 0 ? resolvedPlaceholder : ''}
        data-tag-invalid={draftRejected ? 'true' : undefined}
        aria-describedby={
          [draftRejected ? grammarHintId : undefined, ariaDescribedBy].filter(Boolean).join(' ') ||
          undefined
        }
        aria-invalid={draftRejected ? 'true' : ariaInvalid}
        aria-activedescendant={
          highlightedIndex === -1 ? undefined : `${pillIdBase}-${highlightedIndex}`
        }
        disabled={disabled}
        className={cn(
          'min-w-[8ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed',
          draftRejected && 'text-destructive placeholder:text-destructive/60',
        )}
      />
      {draftRejected && (
        <span
          id={grammarHintId}
          role="alert"
          data-testid="tag-pill-input-error"
          className="w-full px-1 pt-0.5 text-xs text-destructive"
        >
          {FRONTMATTER_TAG_GRAMMAR_HINT}
        </span>
      )}
    </div>
  );
}

export { TagPillInput };
