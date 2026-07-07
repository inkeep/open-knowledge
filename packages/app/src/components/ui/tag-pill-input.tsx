'use client';

import {
  FRONTMATTER_TAG_GRAMMAR_HINT,
  isValidFrontmatterTagValue,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { XIcon } from 'lucide-react';
import { type Ref, useId, useState } from 'react';
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
  /**
   * Forwarded onto the inner `<input>` so RHF's `form.setFocus(name)`
   * resolves through `Controller.field.ref`. Without this, `setFocus` on
   * a TagPillInput-bound field silently no-ops, breaking the L3 rejection
   * focus path for any future schema constraint on `frontmatter.tags`.
   * Matches sibling `Input` / `Textarea` / `Switch` ref-forwarding.
   */
  ref?: Ref<HTMLInputElement>;
}

/**
 * String-array editor rendering each entry as a removable Badge pill plus
 * a native input for adding new entries. Used by FoldersSection for
 * `folders[].frontmatter.tags`.
 *
 * Commit triggers: Enter, comma, Tab (with non-empty draft — Tab on empty
 * preserves default focus shift), and blur. Backspace on an empty draft
 * removes the last pill. Duplicates are silently deduped.
 *
 * The wrapper carries the focus-ring and aria-invalid styling (matches the
 * shadcn `Input` look). The inner `<input>` accepts `id` so a
 * `<FormLabel htmlFor={id}>` resolves to a focusable element; `aria-invalid`
 * propagates onto the wrapper so the destructive ring appears regardless of
 * which child has focus.
 */
function TagPillInput({
  value,
  onChange,
  onBlur,
  placeholder,
  id,
  disabled,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ref,
}: TagPillInputProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState('');
  // Same shape as PropertyWidgets.ListWidget — when an author types an
  // invalid tag and tries to commit, keep the draft on screen with the
  // destructive ring + grammar hint instead of silently dropping
  // their keystrokes. Cleared as soon as they keep typing.
  const [draftRejected, setDraftRejected] = useState(false);
  const fallbackId = useId();
  // Per-instance helper id so multiple TagPillInputs on the same page
  // can't collide on the static `tag-pill-grammar-hint` id (HTML id
  // uniqueness; `getElementById` ambiguity). Prefer the caller-
  // supplied `id` (RHF already derives a stable one via useId()) so
  // the helper stays attached to the same field; fall back to a
  // self-generated useId for standalone callers.
  const grammarHintId = `${id ?? fallbackId}-grammar-hint`;
  const resolvedPlaceholder = placeholder ?? t`Add tag`;

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (!isValidFrontmatterTagValue(tag)) {
      setDraftRejected(true);
      return;
    }
    // Normalize leading `#`. `isValidFrontmatterTagValue` strips
    // a single leading `#` for paste tolerance (Obsidian-shape
    // input), so `#showcase` passes the gate above — but the
    // committed list must hold canonical bare values. Without this,
    // the next on-disk YAML parse would silently re-normalize the
    // value (drifting display) and the dedup check below would
    // miss the duplicate `#showcase` / `showcase` pair.
    const normalized = tag.startsWith('#') ? tag.slice(1) : tag;
    if (value.includes(normalized)) {
      setDraft('');
      setDraftRejected(false);
      return;
    }
    setDraftRejected(false);
    onChange([...value, normalized]);
    setDraft('');
  };

  const removeAt = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  return (
    <div
      data-slot="tag-pill-input"
      // Wrapper aria-invalid covers either the field-level error (passed
      // in by RHF) OR the grammar-gate rejection — both deserve the
      // destructive ring on the surrounding box.
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
        // Pills that fail the grammar gate are arriving from the
        // source-mode editor (or programmatic seed) — surface them
        // with a destructive variant + grammar-hint tooltip so the
        // author can find and clean them up without context-switching.
        const invalid = !isValidFrontmatterTagValue(tag);
        const badge = (
          <Badge
            // Tags are unique within the list (dedup above) — `tag` itself
            // is a stable key that survives reorders.
            key={tag}
            variant={invalid ? 'destructive' : 'secondary'}
            data-tag-invalid={invalid ? 'true' : undefined}
            className={cn('gap-1 pl-2 pr-1', invalid && 'ring-1 ring-destructive/40')}
          >
            <span className="font-mono">{tag}</span>
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
        if (!invalid) return badge;
        return (
          <Tooltip key={tag}>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent>{FRONTMATTER_TAG_GRAMMAR_HINT}</TooltipContent>
          </Tooltip>
        );
      })}
      <input
        id={id}
        ref={ref}
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (draftRejected) setDraftRejected(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (draft.trim()) {
              e.preventDefault();
              addTag(draft);
            }
          } else if (e.key === ',') {
            // Always swallow comma — it's the tag delimiter and must never
            // appear as literal content. Empty-draft comma is a no-op
            // (prevents pressing comma alone from inserting `,` and later
            // being committed as a single-character `,` tag on blur).
            e.preventDefault();
            if (draft.trim()) {
              addTag(draft);
            }
          } else if (e.key === 'Tab') {
            if (draft.trim()) {
              e.preventDefault();
              addTag(draft);
            }
            // Empty draft: let default Tab focus-shift behavior run.
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            e.preventDefault();
            removeAt(value.length - 1);
          } else if (e.key === 'Escape') {
            // Esc clears any in-flight rejection state without committing —
            // matches the PropertyWidgets ListWidget pattern.
            if (draftRejected) {
              e.preventDefault();
              setDraftRejected(false);
            }
          }
        }}
        onBlur={() => {
          if (draft.trim()) addTag(draft);
          onBlur?.();
        }}
        placeholder={value.length === 0 ? resolvedPlaceholder : ''}
        data-tag-invalid={draftRejected ? 'true' : undefined}
        // `aria-describedby` accepts a space-separated id list. When
        // both a field-level error (RHF wires through `ariaDescribedBy`)
        // AND the grammar-gate rejection are active, both ids must point
        // at their respective helpers — choose-one would silently drop
        // the RHF association.
        aria-describedby={
          [draftRejected ? grammarHintId : undefined, ariaDescribedBy].filter(Boolean).join(' ') ||
          undefined
        }
        // Either the RHF-bound `ariaInvalid` or the grammar-gate flag
        // surfaces destructive affordances on the wrapper + input.
        aria-invalid={draftRejected ? 'true' : ariaInvalid}
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
