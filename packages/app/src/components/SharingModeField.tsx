/**
 * Config-sharing posture as two side-by-side radio cards — shared by the
 * open-folder consent dialog (surfaced at the top level, where the choice is
 * more consequential for an existing folder) and the create-project dialog
 * (tucked inside "Advanced settings", since a greenfield project defaults to
 * Shared). The two surfaces intentionally place the field differently.
 *
 * Visible copy stays plain-language; the technical detail (which files, git
 * mechanics) lives in `ConfigSharingInfoTooltip` next to the legend.
 *
 * `idPrefix` namespaces the radio element ids so two instances can coexist;
 * `testIdPrefix` keeps each dialog's existing test ids (`consent-sharing*` /
 * `create-sharing*`) stable.
 */

import { Trans } from '@lingui/react/macro';
import { ConfigSharingInfoTooltip } from '@/components/ConfigSharingInfoTooltip';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

export type SharingMode = 'shared' | 'local-only';

interface SharingModeFieldProps {
  value: SharingMode;
  onValueChange: (value: SharingMode) => void;
  /** Whole control busy/disabled (e.g. while the dialog is submitting). */
  disabled?: boolean;
  idPrefix: string;
  testIdPrefix: string;
}

const CARD_BASE =
  'flex items-start gap-2 rounded-md border p-3 text-sm font-normal transition-colors cursor-pointer';

export function SharingModeField({
  value,
  onValueChange,
  disabled = false,
  idPrefix,
  testIdPrefix,
}: SharingModeFieldProps) {
  const sharedId = `${idPrefix}-sharing-shared`;
  const localId = `${idPrefix}-sharing-local-only`;
  return (
    <fieldset className="flex flex-col space-y-2" data-testid={testIdPrefix}>
      <legend className="flex items-center gap-1.5 text-sm font-medium">
        <Trans>Share this setup with your team?</Trans>
        <ConfigSharingInfoTooltip />
      </legend>
      <RadioGroup
        value={value}
        onValueChange={(v) => onValueChange(v as SharingMode)}
        disabled={disabled}
        className="grid-cols-2 gap-3"
      >
        <Label
          htmlFor={sharedId}
          className={cn(
            CARD_BASE,
            value === 'shared' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
          )}
        >
          <RadioGroupItem
            id={sharedId}
            value="shared"
            data-testid={`${testIdPrefix}-shared`}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">
              <Trans>Shared</Trans>
            </span>
            <span className="block text-1sm text-muted-foreground">
              <Trans>Saved with the project for your team.</Trans>
            </span>
          </span>
        </Label>
        <Label
          htmlFor={localId}
          className={cn(
            CARD_BASE,
            value === 'local-only'
              ? 'border-primary bg-primary/5'
              : 'border-border hover:bg-muted/40',
          )}
        >
          <RadioGroupItem
            id={localId}
            value="local-only"
            data-testid={`${testIdPrefix}-local-only`}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">
              <Trans>Local only</Trans>
            </span>
            <span className="block text-1sm text-muted-foreground">
              <Trans>Stays on this computer.</Trans>
            </span>
          </span>
        </Label>
      </RadioGroup>
    </fieldset>
  );
}
