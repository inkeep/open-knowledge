import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SKILL_NAME_REGEX, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Type } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PropertyDisplayRow } from '@/components/PropertyDisplayRow';
import { PropertyPanel } from '@/components/PropertyPanel';
import { Input } from '@/components/ui/input';
import { useSkills } from '@/hooks/use-skills';
import { skillEntryDirs } from '@/lib/skill-scope';

/**
 * `name` is the skill's folder identity (and the id agents invoke it by), so it
 * is a rename affordance, not a frontmatter property — it is rendered as the
 * first row of the panel with a fixed, non-editable key and hidden from the
 * panel's auto-rendered rows, exactly as a document's filename is not one of
 * its properties.
 */
const SKILL_RESERVED_KEYS = ['name'] as const;

/**
 * Skill identity + properties, rendered as the editor's right-hand panel.
 *
 * The frontmatter editor is the EXACT document `PropertyPanel` (same component,
 * same CRDT binding, same recursive object/nested-frontmatter editor + add /
 * rename / reorder / tags affordances) — skills are not a divergent panel. The
 * only skill-specific row is the identity affordance rendered at the top of the
 * panel: `name` (a rename → git-mv, never a plain patch). It sits inside the
 * Properties disclosure via the panel's `identitySlot`, with `name` reserved out
 * of the panel's rows so it is not double-rendered. A skill's level (scope) is
 * an identity control too, but it lives in the editor toolbar next to the
 * install state, not in this panel.
 */
export function SkillProperties({
  provider,
  scope,
  name,
  onRename,
  nameError,
  onNameDraftChange,
  nameEditable = true,
}: {
  provider: HocuspocusProvider;
  /** Which store the skill lives in — drives the on-disk location hint (§4.4). */
  scope: SkillScope;
  /** Current skill name (identity). In create mode this is the draft name. */
  name: string;
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
  // The skill's REAL on-disk dir from its list entry (in-place skills live in
  // editor dirs, not the store). Absent while the list loads / in create mode /
  // mid-rename to an uncommitted name — those fall back to the derived store
  // path, which is where a NEW name would land.
  const skillsState = useSkills();
  const entry =
    skillsState.status === 'ready'
      ? skillsState.data.find((sk) => sk.scope === scope && sk.name === name)
      : undefined;

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

  const nameRow = (
    <PropertyDisplayRow icon={<Type className="size-3.5" />} label={t`name`} htmlFor={nameId}>
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
      ) : trimmedName ? (
        // Disclose EVERY path the skill occupies (canonical first, then per-host
        // copies; user symlinks labeled) — the same path-first disclosure as the
        // sidebar hover. Mid-rename / create mode falls back to the derived
        // store path a NEW name would land at.
        <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
          <Trans>Saved to</Trans>{' '}
          {entry && trimmedName === name ? (
            skillEntryDirs(entry).map((d, i) => (
              <span key={d.dir}>
                {i > 0 ? ', ' : null}
                <code className="font-mono">{d.dir}</code>
                {d.symlink ? (
                  <span className="italic">
                    {' '}
                    <Trans>(symlink)</Trans>
                  </span>
                ) : null}
              </span>
            ))
          ) : entry ? (
            // Mid-rename: a rename keeps the skill's root — only the leaf
            // changes. Derive the would-be dir from the entry's REAL path
            // (never the retired store).
            <code className="font-mono">
              {`${entry.path
                .replace(/\/SKILL\.mdx?$/i, '')
                .split('/')
                .slice(0, -1)
                .join('/')}/${trimmedName}`}
            </code>
          ) : (
            // Fresh create, list still catching up: the server picks the
            // default skills folder — say so honestly instead of guessing a
            // path (the old fallback claimed the retired `.ok/skills`).
            <Trans>the default skills folder (the exact path appears once saved)</Trans>
          )}
        </p>
      ) : (
        <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
          <Trans>The folder on disk and the id agents use to invoke this skill.</Trans>
        </p>
      )}
    </PropertyDisplayRow>
  );

  // Frontmatter (description, nested objects, tags, add/rename/reorder) is the
  // exact document property panel — the `name` identity row is rendered at the
  // top via `identitySlot` and reserved out of the frontmatter rows below.
  return (
    <PropertyPanel provider={provider} reservedKeys={SKILL_RESERVED_KEYS} identitySlot={nameRow} />
  );
}
