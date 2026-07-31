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
  /**
   * Entry grammar. `frontmatter-tag` (default) enforces the frontmatter
   * `tags:` value grammar: a leading `#` is stripped on commit, invalid
   * entries are rejected with the grammar hint, and non-conforming pills
   * are flagged. `free-text` admits any non-empty entry verbatim — for
   * callers whose entries are not frontmatter tags (markdownlint option
   * lists hold values like `## Summary` that the tag grammar would
   * reject, and whose leading `#` must survive).
   */
  grammar?: 'frontmatter-tag' | 'free-text';
  /**
   * Per-entry problems keyed by the entry's exact value: flags that pill
   * destructive and puts the message in its tooltip. This carries findings for
   * callers whose entries are validated elsewhere — a glob is only known to
   * match nothing once the server has walked the project — so the finding can
   * be shown on the entry that caused it rather than in a list beside it.
   */
  entryProblems?: ReadonlyMap<string, string>;
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
 * a native input for adding new entries. Consumers are the settings surfaces:
 * markdownlint option lists (`rule-option-field`), a frontmatter schema's
 * `appliesTo` globs (`LintingSection`), and a schema field's allowed values —
 * both the field's own and an array field's element values
 * (`frontmatter-schema-field-editor`). All four pass `grammar="free-text"`.
 * The `frontmatter-tag` default is still the grammar a `tags:` editor would
 * want, but nothing binds it today.
 *
 * Commit triggers: Enter, comma, Tab (with non-empty draft — Tab on empty
 * preserves default focus shift), and blur. Backspace on an empty draft
 * removes the last pill. Duplicates are silently deduped.
 *
 * Double-clicking a pill lifts it back into the input with its text selected,
 * so correcting one character doesn't mean deleting the entry and retyping it.
 * The edit is tracked by the entry's value rather than its index, and commits
 * in place: entry order is meaningful to some callers (in a glob list an
 * exclude only subtracts from the includes before it). Escape cancels.
 *
 * Keyboard route to the same thing: ArrowLeft from the start of the input
 * highlights the last entry, Left/Right/Home/End move the highlight, Enter or
 * Space edits it, Backspace/Delete remove it. DOM focus stays on the input and
 * the highlight is reported via `aria-activedescendant`, so the edit affordance
 * adds no tab stops — the only per-entry tab stop is each pill's remove button.
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
  grammar = 'frontmatter-tag',
  entryProblems,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ref,
}: TagPillInputProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState('');
  // The entry currently lifted into the input for editing, held by value (not
  // index) so a concurrent commit that reorders or dedupes the list can't
  // retarget the edit onto a different pill.
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  // Roving highlight: DOM focus stays on the input and arrow keys move a
  // visual selection across the committed entries, which is how Zag/Ark,
  // Dice UI and Reka all model this. Keeping entries out of the tab order
  // matters — a per-entry tab stop would put N stops between the author and
  // the box they are typing in.
  const [highlightedEntry, setHighlightedEntry] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The caller's ref still has to reach the input (RHF resolves setFocus
  // through it), so both are attached.
  const attachInput = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
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
  // Highlighted entries are announced through `aria-activedescendant` on the
  // input, which owns DOM focus the whole time — without it the highlight is
  // a purely visual state that a screen reader never reports.
  const pillIdBase = `${id ?? fallbackId}-pill`;
  const resolvedPlaceholder = placeholder ?? t`Add tag`;

  const tagGrammar = grammar === 'frontmatter-tag';

  const clearDraft = () => {
    setDraft('');
    setDraftRejected(false);
    setEditingEntry(null);
  };

  /** Returns false when the grammar gate rejected the draft (nothing committed). */
  const addTag = (raw: string): boolean => {
    const tag = raw.trim();
    // Index is resolved at commit time — the pill may have moved since the
    // edit began. A vanished entry falls back to the append path.
    const editIndex = editingEntry === null ? -1 : value.indexOf(editingEntry);
    if (!tag) {
      // Only reachable mid-edit: emptying a pill's text is how you delete it
      // from inside the input.
      if (editIndex !== -1) onChange(value.filter((_, i) => i !== editIndex));
      if (editingEntry !== null) clearDraft();
      return true;
    }
    if (tagGrammar && !isValidFrontmatterTagValue(tag)) {
      setDraftRejected(true);
      return false;
    }
    // Normalize leading `#` (tag grammar only). `isValidFrontmatterTagValue`
    // strips a single leading `#` for paste tolerance (Obsidian-shape
    // input), so `#showcase` passes the gate above — but the
    // committed list must hold canonical bare values. Without this,
    // the next on-disk YAML parse would silently re-normalize the
    // value (drifting display) and the dedup check below would
    // miss the duplicate `#showcase` / `showcase` pair. Free-text
    // entries commit verbatim (`## Summary` keeps its `#`s).
    const normalized = tagGrammar && tag.startsWith('#') ? tag.slice(1) : tag;
    const duplicateAt = value.indexOf(normalized);
    if (editIndex === -1) {
      if (duplicateAt === -1) onChange([...value, normalized]);
      clearDraft();
      return true;
    }
    // Write in place so the entry keeps its position. Editing one entry into
    // another's value collapses the pair rather than committing a duplicate.
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
    // Whatever is already in the box is committed rather than dropped —
    // double-clicking a pill mid-typing shouldn't discard the draft.
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

  // Focus + select once the lifted text has rendered, so the whole entry is
  // replaceable by typing but a single character is still reachable.
  useEffect(() => {
    if (editingEntry === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingEntry]);

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
        // The entry being edited lives in the input, not on the row.
        if (tag === editingEntry) return null;
        // Pills that fail the grammar gate are arriving from the
        // source-mode editor (or programmatic seed) — surface them
        // with a destructive variant + grammar-hint tooltip so the
        // author can find and clean them up without context-switching.
        // Free-text mode has no grammar, so nothing to flag.
        const invalid = tagGrammar && !isValidFrontmatterTagValue(tag);
        const problem = entryProblems?.get(tag);
        const flagged = invalid || problem !== undefined;
        const hint = problem ?? (invalid ? FRONTMATTER_TAG_GRAMMAR_HINT : undefined);
        const highlighted = tag === highlightedEntry;
        const badge = (
          <Badge
            // Tags are unique within the list (dedup above) — `tag` itself
            // is a stable key that survives reorders.
            key={tag}
            id={`${pillIdBase}-${i}`}
            variant={flagged ? 'destructive' : 'secondary'}
            data-tag-invalid={invalid ? 'true' : undefined}
            data-tag-problem={problem !== undefined ? 'true' : undefined}
            data-highlighted={highlighted ? 'true' : undefined}
            // Badge uppercases by default; these entries are case-sensitive
            // values (globs, tags, option strings) and must read as authored.
            className={cn(
              'gap-1 pl-2 pr-1 normal-case',
              flagged && 'ring-1 ring-destructive/40',
              highlighted && 'ring-2 ring-ring/70',
            )}
          >
            {/*
             * A button rather than a styled span so the double-click handler
             * sits on something interactive, but `tabIndex={-1}` keeps it out
             * of the tab order: the keyboard route in is the roving highlight
             * on the input (arrow keys, then Enter), not a stop per entry.
             */}
            <button
              type="button"
              tabIndex={-1}
              className="cursor-pointer rounded-sm font-mono"
              onDoubleClick={() => beginEdit(tag)}
              disabled={disabled}
              aria-label={t`Edit ${tag}`}
              // Suppress the native hint on a flagged pill: its Badge already
              // carries a Radix tooltip with the problem detail, and two
              // tooltips on one control stack and compete. The aria-label still
              // conveys the edit affordance.
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
          // Typing is unambiguously about the draft, not the highlighted entry.
          if (highlightedEntry !== null) setHighlightedEntry(null);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          // Left only spills out of the text once the caret is already at the
          // start, so arrowing through what you are typing still works.
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
              // Past the last entry the highlight drops and the caret is live.
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
            // Space activates like Enter (roving-item convention). preventDefault
            // stops the space from being typed into the draft — a highlighted
            // entry means the input is in navigation mode, not text entry.
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const entry = value[highlightedIndex];
              if (entry !== undefined) beginEdit(entry);
              return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              // Neighbours are captured by value: the indices shift under the
              // removal, the values do not.
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
          } else if (
            e.key === 'Backspace' &&
            draft === '' &&
            value.length > 0 &&
            // Mid-edit the box is empty because the author cleared it, not
            // because there is nothing to commit — don't also eat a pill.
            editingEntry === null
          ) {
            e.preventDefault();
            removeAt(value.length - 1);
          } else if (e.key === 'Escape') {
            // Esc abandons an in-flight edit (the pill returns untouched),
            // drops the highlight, and otherwise clears rejection state
            // without committing — matches the PropertyWidgets ListWidget.
            if (editingEntry !== null || draftRejected) {
              e.preventDefault();
              clearDraft();
              setHighlightedEntry(null);
            } else if (highlightedIndex !== -1) {
              // Highlight-only Escape drops the selection and leaves the draft
              // alone — the author was navigating, not editing.
              e.preventDefault();
              setHighlightedEntry(null);
            }
          }
        }}
        onBlur={() => {
          // An emptied edit box still commits, since that is the delete
          // gesture; an empty add box has nothing to do.
          if (draft.trim() || editingEntry !== null) {
            // A grammar rejection commits nothing. Focus has already left, so
            // the edit is abandoned and the entry returns to the row — leaving
            // `editingEntry` set would keep filtering it out of the render
            // while `value` still holds it, hiding it entirely.
            if (!addTag(draft) && editingEntry !== null) clearDraft();
          }
          setHighlightedEntry(null);
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
