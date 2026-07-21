/**
 * Integrations section — the "Install in Claude Desktop" row opens
 * `<InstallInClaudeDesktopDialog>` (its own internal Dialog).
 */

import { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { InstallInClaudeDesktopDialog } from '@/components/InstallInClaudeDesktopDialog';
import { Button } from '@/components/ui/button';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';

export function IntegrationsSection() {
  const [installOpen, setInstallOpen] = useState(false);
  const { skillInstalled, refresh } = useClaudeDesktopIntegration();
  if (!SHOW_INSTALL_SKILL) return null;

  return (
    <section aria-labelledby="settings-integrations-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="settings-integrations-title" className="text-base font-semibold">
          <Trans>Integrations</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Connect OpenKnowledge to other tools you use.</Trans>
        </p>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">
              <Trans>Install in Claude Desktop</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>Make this knowledge base available as a Claude Skill.</Trans>
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setInstallOpen(true)}
            data-testid="settings-install-claude-desktop"
            className="uppercase font-mono"
          >
            {skillInstalled ? <Trans>Reinstall</Trans> : <Trans>Install</Trans>}
          </Button>
        </div>
      </div>
      <InstallInClaudeDesktopDialog
        open={installOpen}
        onOpenChange={(next) => {
          setInstallOpen(next);
          if (!next) refresh();
        }}
        reinstall={skillInstalled}
      />
    </section>
  );
}
