import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SKILL_NAME_REGEX, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Gauge, Type } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PropertyDisplayRow } from '@/components/PropertyDisplayRow';
import { PropertyPanel } from '@/components/PropertyPanel';
import { SkillCostValue } from '@/components/SkillCostValue';
import { Input } from '@/components/ui/input';
import { useSkills } from '@/hooks/use-skills';
import { SKILL_RESERVED_KEYS } from '@/lib/reserved-property-keys';
import { skillEntryDirs } from '@/lib/skill-scope';

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
  scope: SkillScope;
  name: string;
  onRename?: (next: string) => void;
  nameError?: string | null;
  onNameDraftChange?: (next: string) => void;
  nameEditable?: boolean;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const skillsState = useSkills();
  const entry =
    skillsState.status === 'ready'
      ? skillsState.data.find((sk) => sk.scope === scope && sk.name === name)
      : undefined;

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
            <code className="font-mono">
              {`${entry.path
                .replace(/\/SKILL\.mdx?$/i, '')
                .split('/')
                .slice(0, -1)
                .join('/')}/${trimmedName}`}
            </code>
          ) : (
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

  const tokensRow = entry?.size ? (
    <PropertyDisplayRow icon={<Gauge className="size-3.5" />} label={t`tokens`}>
      <SkillCostValue size={entry.size} />
    </PropertyDisplayRow>
  ) : null;

  return (
    <PropertyPanel
      provider={provider}
      reservedKeys={SKILL_RESERVED_KEYS}
      identitySlot={
        <>
          {nameRow}
          {tokensRow}
        </>
      }
    />
  );
}
