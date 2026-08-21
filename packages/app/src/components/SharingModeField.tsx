/**
 * Config-sharing posture as two side-by-side radio cards — shared by the
 * open-folder consent dialog and the create-project dialog. Both surfaces
 * place it at the top level and default to "Only me"; sharing with the team
 * is an explicit opt-in.
 *
 * Visible copy stays plain-language; the technical detail (which files, git
 * mechanics) lives in `ConfigSharingInfoTooltip` next to the legend.
 *
 * `idPrefix` namespaces the radio element ids so two instances can coexist;
 * `testIdPrefix` keeps each dialog's existing test ids (`consent-sharing*` /
 * `create-sharing*`) stable.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { ConfigSharingInfoTooltip } from '@/components/ConfigSharingInfoTooltip';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { cn } from '@/lib/utils';

/**
 * Config sharing, NOT the Share-links feature. `docs/features/share` is about
 * copying an `openknowledge.ai/d/…` deep link to a doc; this field decides
 * whether `.ok/`, `.mcp.json`, and project skills are committed or kept out of
 * git via `.git/info/exclude`. That mechanic is documented here.
 */
const CONFIG_SHARING_DOCS_URL =
  'https://openknowledge.ai/docs/reference/what-open-knowledge-writes';

export type SharingMode = 'shared' | 'local-only';

/**
 * What both setup dialogs pre-select. Sharing the setup with the team is an
 * explicit opt-in, so a user who never reads the field does not publish their
 * config by omission. One constant rather than a literal per dialog, so the
 * two cannot drift. `ok init` seeds the same answer for a project it is
 * scaffolding for the first time (`resolveSharingMode`'s `freshProject` seed),
 * so every entry point makes sharing the explicit choice.
 */
export const DEFAULT_SHARING_MODE: SharingMode = 'local-only';

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
  const { t } = useLingui();
  const sharedId = `${idPrefix}-sharing-shared`;
  const localId = `${idPrefix}-sharing-local-only`;
  const labelId = `${idPrefix}-sharing-label`;
  // Plain div header + `aria-labelledby` on the RadioGroup, matching
  // SharingSection: it names the radiogroup element itself, and keeps the docs
  // link out of that accessible name. A fieldset/legend cannot do the second
  // part, since the link has to sit on the label row and legend content IS the
  // group's name.
  return (
    <div className="flex flex-col space-y-2" data-testid={testIdPrefix}>
      <div className="flex items-center gap-1.5">
        <span id={labelId} className="text-sm font-medium">
          <Trans>Share this setup with your team?</Trans>
        </span>
        <ConfigSharingInfoTooltip />
        {/* Docs link on the trailing edge of the label row, styled like the
          setup rows' "What changes?" trigger (dotted underline, same size).
          Visible text stays "Learn more" because the row is space-constrained
          and already headed by the sharing question; the accessible name spells
          out the destination, which is what a screen reader's links list reads
          (it enumerates links with no surrounding context). */}
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
      {/* "Only me" leads (it is the default), "Shared" is the opt-in. */}
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
