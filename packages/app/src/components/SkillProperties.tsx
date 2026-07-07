import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SKILL_NAME_REGEX, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FolderGit2, Type } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { PropertyPanel } from '@/components/PropertyPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SKILL_SCOPE_ORDER, useSkillScopePillLabels } from '@/lib/skill-scope';
import { cn } from '@/lib/utils';

/**
 * `name` is the skill's folder identity (and the id agents invoke it by), so it
 * is a rename affordance, not a frontmatter property — it is rendered above the
 * panel and hidden from the panel's auto-rendered rows, exactly as a document's
 * filename is not one of its properties.
 */
const SKILL_RESERVED_KEYS = ['name'] as const;

/** Lets the create flow pick the new skill's scope inline (edit mode omits it). */
interface ScopeControl {
  scope: SkillScope;
  onScopeChange: (scope: SkillScope) => void;
}

/**
 * Skill identity + properties, rendered as the editor's right-hand panel.
 *
 * The frontmatter editor is the EXACT document `PropertyPanel` (same component,
 * same CRDT binding, same recursive object/nested-frontmatter editor + add /
 * rename / reorder / tags affordances) — skills are not a divergent panel. The
 * only skill-specific rows are the identity affordances above it: `name` (a
 * rename → git-mv, never a plain patch) and, in create mode, the scope picker
 * (an OK concept, not a `SKILL.md` field). `name` is reserved out of the
 * panel's rows so it is not double-rendered.
 */
export function SkillProperties({
  provider,
  name,
  scopeControl,
  onRename,
  nameError,
  onNameDraftChange,
  nameEditable = true,
}: {
  provider: HocuspocusProvider;
  /** Current skill name (identity). In create mode this is the draft name. */
  name: string;
  scopeControl?: ScopeControl;
  /** Commit a rename (edit mode) — fired on the name field's blur/Enter with a
   *  changed, grammar-valid name. Omitted → the name field is read-only. */
  onRename?: (next: string) => void;
  /** Inline error under the name field (e.g. collision), supplied by the parent. */
  nameError?: string | null;
  /** Report name keystrokes (create mode scaffolds once the name is valid). */
  onNameDraftChange?: (next: string) => void;
  /** False → render the name as read-only text (e.g. while a rename is in flight). */
  nameEditable?: boolean;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const scopeId = useId();
  const scopeLabels = useSkillScopePillLabels();

  // Local draft for the name field so typing doesn't fight the committed identity.
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  const trimmedName = nameDraft.trim();
  const nameInvalid = trimmedName !== '' && !SKILL_NAME_REGEX.test(trimmedName);

  function commitName() {
    if (!onRename) return;
    if (nameInvalid || trimmedName === '' || trimmedName === name) return;
    onRename(trimmedName);
  }

  const showNameError = nameInvalid || Boolean(nameError);

  return (
    <div className="flex flex-col">
      {/* Identity rows (above the reused property panel). Wrapped in the same
          `editor-content-aligned` grid the PropertyPanel uses so scope/name land
          in the editor's content column — same left indent and value column as
          the frontmatter rows below, instead of flush against the panel edge. */}
      <div className="editor-content-aligned gap-0.5 pt-4">
        {scopeControl ? (
          <PropertyRow
            icon={<FolderGit2 className="size-3.5" />}
            label={t`Level`}
            htmlFor={scopeId}
          >
            {/* Color-coded level pill — the prominent, obvious switch between a
                Project skill (shared, in this repo) and a Global skill (available
                in every project). Both segments stay visible so the alternative
                is a one-tap target, not hidden behind a dropdown. Tapping the
                inactive segment moves the skill to that level. */}
            {/* Toggle-button group (not an ARIA radiogroup): each segment is a
                normal Button tab stop with `aria-pressed`, so we don't owe the
                WAI-ARIA radio roving-tabindex/arrow-key contract. Active colors
                use the -700 shades so white text clears WCAG AA (≥4.5:1) at the
                12px `text-xs` size. */}
            <fieldset
              id={scopeId}
              className="m-0 inline-flex items-center gap-1 rounded-full border-0 bg-muted/60 p-0.5"
            >
              <legend className="sr-only">{t`Skill level`}</legend>
              {SKILL_SCOPE_ORDER.map((s) => {
                const active = scopeControl.scope === s;
                return (
                  <Button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (!active) scopeControl.onScopeChange(s);
                    }}
                    className={cn(
                      'h-6 rounded-full px-3 text-xs font-medium',
                      active
                        ? s === 'global'
                          ? 'bg-violet-700 text-white hover:bg-violet-700 hover:text-white'
                          : 'bg-sky-700 text-white hover:bg-sky-700 hover:text-white'
                        : 'text-muted-foreground hover:bg-transparent hover:text-foreground',
                    )}
                  >
                    {scopeLabels[s]}
                  </Button>
                );
              })}
            </fieldset>
          </PropertyRow>
        ) : null}
        <PropertyRow icon={<Type className="size-3.5" />} label={t`name`} htmlFor={nameId}>
          <Input
            id={nameId}
            data-testid="skill-name-input"
            value={nameDraft}
            readOnly={!nameEditable}
            onChange={(e) => {
              const next = e.target.value;
              setNameDraft(next);
              onNameDraftChange?.(next);
            }}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            aria-invalid={showNameError}
            aria-describedby={showNameError ? `${nameId}-error` : undefined}
            className="h-7 rounded-sm border-transparent bg-transparent px-2 font-mono text-sm shadow-none focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0 dark:bg-transparent"
          />
          {showNameError ? (
            <p id={`${nameId}-error`} className="px-1 pt-0.5 text-[11px] text-destructive">
              {nameError ? (
                nameError
              ) : (
                <Trans>
                  Use lowercase letters, digits, and <code className="font-mono">-</code> only.
                </Trans>
              )}
            </p>
          ) : (
            <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
              <Trans>The folder on disk and the id agents use to invoke this skill.</Trans>
            </p>
          )}
        </PropertyRow>
      </div>
      {/* Frontmatter (description, nested objects, tags, add/rename/reorder) is
          the exact document property panel — `name` is reserved (identity row). */}
      <PropertyPanel provider={provider} reservedKeys={SKILL_RESERVED_KEYS} />
    </div>
  );
}

/** One identity row: type icon + fixed-width label column + inline value. Mirrors
 *  `FrontmatterRow`'s identity layout so it lines up with the reused panel below. */
function PropertyRow({
  icon,
  label,
  htmlFor,
  children,
}: {
  icon: ReactNode;
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-1 py-0.5">
      {/* Gutter mirrors FrontmatterRow (drag-handle w-4 + type-icon size-7) so the
          identity rows align column-for-column with the frontmatter rows below. */}
      <span aria-hidden className="h-7 w-4 shrink-0" />
      <div className="flex items-center gap-1">
        <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <label
          htmlFor={htmlFor}
          className="flex h-7 w-32 shrink-0 items-center truncate px-2 text-sm text-muted-foreground"
        >
          {label}
        </label>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
