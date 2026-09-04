import { Trans, useLingui } from '@lingui/react/macro';
import { ConfigSharingInfoTooltip } from '@/components/ConfigSharingInfoTooltip';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';

const CONFIG_SHARING_DOCS_URL =
  'https://openknowledge.ai/docs/reference/what-open-knowledge-writes';

export type SharingMode = 'shared' | 'local-only';

export const DEFAULT_SHARING_MODE: SharingMode = 'local-only';

interface SharingModeFieldProps {
  value: SharingMode;
  onValueChange: (value: SharingMode) => void;
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
  const { t } = useLingui();
  const sharedId = `${idPrefix}-sharing-shared`;
  const localId = `${idPrefix}-sharing-local-only`;
  const labelId = `${idPrefix}-sharing-label`;
  return (
    <div className="flex flex-col space-y-2" data-testid={testIdPrefix}>
      <div className="flex items-center gap-1.5">
        <span id={labelId} className="text-sm font-medium">
          <Trans>Share this setup with your team?</Trans>
        </span>
        <ConfigSharingInfoTooltip />
        {}
        <a
          href={CONFIG_SHARING_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, CONFIG_SHARING_DOCS_URL)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, CONFIG_SHARING_DOCS_URL)}
          aria-label={t`Learn more about config sharing`}
          className="ms-auto text-1sm font-normal text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
          data-testid={`${testIdPrefix}-docs-link`}
        >
          <Trans>Learn more</Trans>
        </a>
      </div>
      {}
      <RadioGroup
        value={value}
        onValueChange={(v) => onValueChange(v as SharingMode)}
        disabled={disabled}
        className="grid-cols-2 gap-3"
        aria-labelledby={labelId}
      >
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
              <Trans>Only me</Trans>
            </span>
            <span className="block text-1sm text-muted-foreground">
              <Trans>Stays on this computer. Not committed to git.</Trans>
            </span>
          </span>
        </Label>
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
      </RadioGroup>
    </div>
  );
}
