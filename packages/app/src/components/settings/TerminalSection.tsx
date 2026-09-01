import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useTerminalConsentState, useTerminalEnabledWriter } from '@/hooks/use-terminal-enabled';
import { useConfigContext } from '@/lib/config-provider';
import { ScopeBadge } from './ScopeBadge';
import { SettingsSectionHeader } from './SettingsSectionHeader';

export function TerminalSection() {
  const { t } = useLingui();
  const { enabled, synced } = useTerminalConsentState();
  const writer = useTerminalEnabledWriter();
  const isOn = enabled !== false;

  const { userConfig, userBinding, userSynced } = useConfigContext();
  const autoApproveOn = userConfig?.agents?.autoApproveOkTools !== false;

  const [codexNeedsInit, setCodexNeedsInit] = useState(false);
  useEffect(() => {
    const bridge = window.okDesktop;
    if (!bridge) return;
    let cancelled = false;
    bridge.terminal
      .cliPreflight('codex')
      .then((res) => {
        if (!cancelled) {
          setCodexNeedsInit(res.onPath === 'present' && res.okServerConfigured !== true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function applyEnabled(next: boolean): void {
    if (writer === null) {
      toast.error(t`Terminal settings not yet loaded — try again in a moment`);
      return;
    }
    const result = writer(next);
    if (!result.ok) {
      toast.error(
        next
          ? t`Could not enable the terminal: ${result.error}`
          : t`Could not turn off the terminal: ${result.error}`,
      );
    }
  }

  function applyAutoApprove(next: boolean): void {
    if (userBinding === null) {
      toast.error(t`Auto-approve settings not yet loaded — try again in a moment`);
      return;
    }
    const result = userBinding.patch({ agents: { autoApproveOkTools: next } });
    if (!result.ok) {
      const detail = humanFormat(result.error);
      toast.error(t`Failed to update the auto-approve setting — ${detail}`);
    }
  }

  return (
    <section
      aria-labelledby="settings-terminal-title"
      className="space-y-3"
      data-field="section:terminal"
      data-testid="settings-terminal"
    >
      {}
      <SettingsSectionHeader
        titleId="settings-terminal-title"
        title={t`Terminal`}
        scope="project-local"
        level="block"
      >
        {t`Run a real terminal docked inside OpenKnowledge, starting in this project's folder.`}
      </SettingsSectionHeader>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <label htmlFor="settings-terminal-toggle" className="text-sm font-medium">
            {t`Enable terminal for this project`}
          </label>
          <p className="text-1sm text-muted-foreground" data-testid="settings-terminal-body">
            {isOn
              ? t`Commands run with the full access of your user account on this machine. Turn this off to disable the shell.`
              : t`A real shell is off for this project. Turning it on runs commands with the full access of your user account.`}
          </p>
        </div>
        <Switch
          id="settings-terminal-toggle"
          checked={isOn}
          onCheckedChange={applyEnabled}
          disabled={!synced || writer === null}
          aria-label={t`Enable terminal for this project`}
          data-testid="settings-terminal-toggle"
        />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <label htmlFor="settings-terminal-autoapprove-toggle" className="text-sm font-medium">
              {t`Let agents use OpenKnowledge without asking`}
            </label>
            <ScopeBadge scope="user" />
          </div>
          <p
            className="text-1sm text-muted-foreground"
            data-testid="settings-terminal-autoapprove-body"
          >
            {t`Applies to all projects on this machine. Claude and Codex, started from the built-in terminal, auto-approve OpenKnowledge's read and write tools (Claude also auto-runs "ok open"). Deleting, moving, sharing, importing or installing skills, other commands, and non-OpenKnowledge file edits still ask. Cursor, OpenCode, and Pi are unaffected. Best-effort per agent.`}
          </p>
          {autoApproveOn && codexNeedsInit ? (
            <p
              className="text-1sm text-muted-foreground"
              data-testid="settings-terminal-autoapprove-codex-note"
            >
              {t`Codex will still ask until you run "ok init" in a terminal for this project.`}
            </p>
          ) : null}
        </div>
        <Switch
          id="settings-terminal-autoapprove-toggle"
          checked={autoApproveOn}
          onCheckedChange={applyAutoApprove}
          disabled={!userSynced || userBinding === null}
          aria-label={t`Let agents use OpenKnowledge without asking`}
          data-testid="settings-terminal-autoapprove-toggle"
        />
      </div>
    </section>
  );
}
