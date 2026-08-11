/**
 * Settings → This project → Content rules — the validation-surface knobs that
 * are NOT lint plugins: how broken internal links are classified (hidden /
 * warning / error) and whether the file tree tints problem files. Both are
 * project-scope (`validation.*` in config.yml, committed and shared via git);
 * the lint plugins themselves are managed on their own tab.
 */
import {
  DEFAULT_LINKS_VALIDATION,
  humanFormat,
  type LinksValidationSetting,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfigContext } from '@/lib/config-provider';

export function ContentRulesSection() {
  const { t } = useLingui();
  const { projectConfig, projectSynced, projectBinding } = useConfigContext();
  const bindingReady = projectSynced && projectBinding !== null;
  const linksSetting: LinksValidationSetting =
    projectConfig?.validation?.links ?? DEFAULT_LINKS_VALIDATION;
  const indicatorsOn = projectConfig?.validation?.fileTreeIndicators !== false;

  function write(patch: { links?: LinksValidationSetting; fileTreeIndicators?: boolean }): void {
    if (projectBinding === null) {
      toast.error(t`Content rules not yet loaded — try again in a moment`);
      return;
    }
    const result = projectBinding.patch({ validation: patch });
    if (!result.ok) {
      toast.error(t`Failed to save content rules — ${humanFormat(result.error)}`);
    }
  }

  return (
    <section
      aria-labelledby="settings-content-rules-title"
      className="space-y-4"
      data-testid="settings-content-rules"
    >
      <div className="space-y-1">
        <h3 id="settings-content-rules-title" className="text-base font-semibold">
          <Trans>Content rules</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            How validation findings surface across the project. These choices are committed to
            config.yml and shared with every collaborator via git.
          </Trans>
        </p>
      </div>

      <div className="divide-y rounded-md border">
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <Label htmlFor="settings-content-rules-links" className="text-sm font-medium">
              <Trans>Broken internal links</Trans>
            </Label>
            <p
              id="settings-content-rules-links-description"
              className="text-1sm text-muted-foreground"
            >
              <Trans>
                How missing project-local documents, files, and images are reported in Problems,
                editor diagnostics, audits, and agent tools.
              </Trans>
            </p>
          </div>
          <Select
            value={linksSetting}
            onValueChange={(next) => write({ links: next as LinksValidationSetting })}
            disabled={!bindingReady}
          >
            <SelectTrigger
              id="settings-content-rules-links"
              aria-describedby="settings-content-rules-links-description"
              className="w-36 shrink-0"
              data-testid="settings-content-rules-links"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">
                <Trans>Don't show</Trans>
              </SelectItem>
              <SelectItem value="warning">
                <Trans>Warning</Trans>
              </SelectItem>
              <SelectItem value="error">
                <Trans>Error</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <Label htmlFor="settings-content-rules-indicators" className="text-sm font-medium">
              <Trans>Problem indicators in the file explorer</Trans>
            </Label>
            <p
              id="settings-content-rules-indicators-description"
              className="text-1sm text-muted-foreground"
            >
              <Trans>
                Tint and badge files that have lint or link problems, without opening them.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-content-rules-indicators"
            aria-describedby="settings-content-rules-indicators-description"
            checked={indicatorsOn}
            disabled={!bindingReady}
            onCheckedChange={(next) => write({ fileTreeIndicators: next })}
            aria-label={indicatorsOn ? t`Hide problem indicators` : t`Show problem indicators`}
            data-testid="settings-content-rules-indicators"
          />
        </div>
      </div>

      <p
        className="text-sm text-muted-foreground"
        data-testid="settings-content-rules-plugins-note"
      >
        <Trans>
          Lint plugins — which rule families run and their per-rule settings — are configured on
          their own tab under This project → Plugins.
        </Trans>
      </p>
    </section>
  );
}
