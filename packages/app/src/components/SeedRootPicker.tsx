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
      {}
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
