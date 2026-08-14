import { Trans, useLingui } from '@lingui/react/macro';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

export type SeedRootChoice = 'project-root' | 'subfolder';

/**
 * "Where should it live?" chooser for a starter-pack scaffold — project root
 * (the default) or a named subfolder. Shared by the in-project seed dialog and
 * the create-new-project dialog so both offer the same choice with the same
 * default; a pack's `defaultSubfolder` only pre-fills the input, it never
 * silently becomes the destination.
 *
 * `idPrefix` keeps the radio ids unique when two instances could mount at once.
 */
export function SeedRootPicker({
  choice,
  subfolder,
  placeholder,
  idPrefix = 'seed-root',
  onChoiceChange,
  onSubfolderChange,
}: {
  choice: SeedRootChoice;
  subfolder: string;
  placeholder: string;
  idPrefix?: string;
  onChoiceChange: (next: SeedRootChoice) => void;
  onSubfolderChange: (next: string) => void;
}) {
  const { t } = useLingui();
  const projectRootId = `${idPrefix}-project-root`;
  const subfolderId = `${idPrefix}-subfolder`;
  const groupLabelId = `${idPrefix}-group-label`;
  return (
    <div className="space-y-2 py-1">
      {/* The heading is bound to the group with aria-labelledby, not left as a
          visual-only <p>: assistive tech announces the radios with no group
          context otherwise. */}
      <p id={groupLabelId} className="text-sm font-medium">
        <Trans>Where should it live?</Trans>
      </p>
      <RadioGroup
        aria-labelledby={groupLabelId}
        className="sm:flex"
        value={choice}
        onValueChange={(next) => onChoiceChange(next as SeedRootChoice)}
      >
        <FieldLabel htmlFor={projectRootId}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                <Trans>Project root</Trans>
              </FieldTitle>
              <FieldDescription className="text-1sm">
                <Trans>Add it directly to this project.</Trans>
              </FieldDescription>
            </FieldContent>
            <RadioGroupItem value="project-root" id={projectRootId} />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor={subfolderId}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>
                <Trans>In a subfolder</Trans>
              </FieldTitle>
              <FieldDescription className="nth-last-2:mt-0 text-1sm">
                <Trans>Reused if it already exists, created if not.</Trans>
              </FieldDescription>
              {choice === 'subfolder' && (
                <Input
                  value={subfolder}
                  onChange={(e) => onSubfolderChange(e.target.value)}
                  placeholder={placeholder}
                  aria-label={t`Subfolder name`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="mt-1.5 font-mono text-xs bg-background"
                />
              )}
            </FieldContent>
            <RadioGroupItem value="subfolder" id={subfolderId} />
          </Field>
        </FieldLabel>
      </RadioGroup>
    </div>
  );
}
