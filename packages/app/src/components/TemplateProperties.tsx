import type { HocuspocusProvider } from '@hocuspocus/provider';
import { TEMPLATE_NAME_REGEX } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FolderGit2, Type } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { PropertyDisclosure } from '@/components/PropertyDisclosure';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFrontmatterField } from '@/lib/use-frontmatter-field';

/**
 * Template identity rendered as the document editor's "Properties" panel, bound
 * to the SAME CRDT doc the body editor edits. `title` + `description` live in
 * the template's YAML region and bind live via `bindFrontmatterDoc` (shared
 * `useFrontmatterField`) — an edit is a CRDT mutation, not a side-channel PUT.
 * `name` is the filename identity; editing it RENAMES (git-mv via `onRename`),
 * committed on blur/Enter. `folder` is shown read-only (move-to-folder is a
 * separate action).
 */
export function TemplateProperties({
  provider,
  name,
  folder,
  onRename,
  nameError,
}: {
  provider: HocuspocusProvider;
  name: string;
  /** Project-root-relative owning folder (`''` = project root), shown read-only. */
  folder: string;
  /** Commit a rename (blur/Enter with a changed, grammar-valid name). */
  onRename?: (next: string) => void;
  nameError?: string | null;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const folderId = useId();

  const title = useFrontmatterField(provider, 'title');
  const description = useFrontmatterField(provider, 'description');

  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => setNameDraft(name), [name]);
  const trimmedName = nameDraft.trim();
  const nameInvalid = trimmedName !== '' && !TEMPLATE_NAME_REGEX.test(trimmedName);
  function commitName() {
    if (!onRename) return;
    if (nameInvalid || trimmedName === '' || trimmedName === name) return;
    onRename(trimmedName);
  }
  const showNameError = nameInvalid || Boolean(nameError);

  return (
    <PropertyDisclosure title={<Trans>Properties</Trans>} className="pt-4 pb-2">
      <PropertyRow icon={<FolderGit2 className="size-3.5" />} label={t`folder`} htmlFor={folderId}>
        <Input
          id={folderId}
          value={folder || '/'}
          readOnly
          className="h-8 border-input bg-transparent px-2 font-mono text-muted-foreground shadow-none"
        />
      </PropertyRow>
      <PropertyRow icon={<Type className="size-3.5" />} label={t`name`} htmlFor={nameId}>
        <Input
          id={nameId}
          data-testid="template-name-input"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-invalid={showNameError}
          className="h-8 border-input bg-transparent px-2 font-mono shadow-none focus-visible:bg-muted/30"
        />
        {showNameError ? (
          <p className="px-1 pt-0.5 text-[11px] text-destructive">
            {nameError ? (
              nameError
            ) : (
              <Trans>
                Use letters, digits, <code className="font-mono">_</code> and{' '}
                <code className="font-mono">-</code> only.
              </Trans>
            )}
          </p>
        ) : (
          <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
            <Trans>The template's filename (without `.md`).</Trans>
          </p>
        )}
      </PropertyRow>
      <PropertyRow icon={<Type className="size-3.5" />} label={t`title`} htmlFor={titleId}>
        <Input
          id={titleId}
          data-testid="template-title-input"
          value={title.value}
          onChange={(e) => title.setValue(e.target.value)}
          onFocus={title.onFocus}
          onBlur={title.onBlur}
          className="h-8 border-input bg-transparent px-2 shadow-none focus-visible:bg-muted/30"
        />
        <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
          <Trans>The menu label agents pick this template by (required).</Trans>
        </p>
      </PropertyRow>
      <PropertyRow
        icon={<Type className="size-3.5" />}
        label={t`description`}
        htmlFor={descriptionId}
      >
        <Textarea
          id={descriptionId}
          data-testid="template-description-input"
          value={description.value}
          onChange={(e) => description.setValue(e.target.value)}
          onFocus={description.onFocus}
          onBlur={description.onBlur}
          className="min-h-16 resize-none border-input bg-transparent px-2 py-1.5 shadow-none focus-visible:bg-muted/30"
        />
        <p className="px-1 pt-0.5 text-[11px] text-muted-foreground">
          <Trans>Disambiguates similarly-named templates in the menu.</Trans>
        </p>
      </PropertyRow>
    </PropertyDisclosure>
  );
}

/** One property row: type icon + fixed-width label column + inline value. */
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
      <label htmlFor={htmlFor} className="flex w-32 shrink-0 items-center gap-1 pt-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <span className="truncate text-muted-foreground">{label}</span>
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
