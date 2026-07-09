/**
 * Settings → Terminal: two desktop-only toggles.
 *  1. The per-project opt-out for the in-app real OS shell (`terminal.enabled`,
 *     project-local — reads/writes via `use-terminal-enabled`).
 *  2. A per-machine (user-scope) toggle to auto-approve OpenKnowledge's OWN tools
 *     for agents launched from the docked terminal (`agents.autoApproveOkTools`).
 *     Default on; only an explicit `false` reads as off. Written through the
 *     user ConfigBinding (`~/.ok/global.yml`), so it spans every project on this
 *     machine — distinct from the per-project shell toggle above. Carries an
 *     inline note when codex is installed but cannot honor the toggle.
 */
import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useTerminalConsentState, useTerminalEnabledWriter } from '@/hooks/use-terminal-enabled';
import { useConfigContext } from '@/lib/config-provider';

export function TerminalSection() {
  const { t } = useLingui();
  const { enabled, synced } = useTerminalConsentState();
  const writer = useTerminalEnabledWriter();
  const isOn = enabled !== false;

  const { userConfig, userBinding, userSynced } = useConfigContext();
  // Default on: only an explicit `false` reads as off (mirrors the launch-site
  // `?? true` fallback in TerminalPanel).
  const autoApproveOn = userConfig?.agents?.autoApproveOkTools !== false;

  // Codex can only honor the toggle when OK's server entry already exists in its
  // config — the launch site withholds the `-c` override otherwise (a `-c` under
  // an undefined server id breaks codex's config load). Surface that rather than
  // let the user watch codex prompt anyway with no explanation. Same preflight
  // the launch runs; the section is desktop-only, so no bridge means no note.
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
      .catch(() => {
        // A failed probe is indistinguishable from "not installed" here — stay quiet
        // rather than warn about a CLI the user may not have.
      });
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
    <section aria-labelledby="settings-terminal-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="settings-terminal-title" className="text-base font-semibold">
          {t`Terminal`}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t`Run a real terminal docked inside OpenKnowledge, starting in this project's folder.`}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <label htmlFor="settings-terminal-toggle" className="text-sm font-medium">
            {t`Enable terminal for this project`}
          </label>
          <p className="text-1sm text-muted-foreground" data-testid="settings-terminal-body">
            {isOn
              ? t`Commands run with the full access of your macOS user account on this machine. Turn this off to disable the shell.`
              : t`A real shell is off for this project. Turning it on runs commands with the full access of your macOS user account.`}
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
          <label htmlFor="settings-terminal-autoapprove-toggle" className="text-sm font-medium">
            {t`Let agents use OpenKnowledge without asking`}
          </label>
          <p
            className="text-1sm text-muted-foreground"
            data-testid="settings-terminal-autoapprove-body"
          >
            {t`Applies to all projects on this machine. Claude and Codex, started from the built-in terminal, auto-approve OpenKnowledge's read and write tools (Claude also auto-runs "ok open"). Deleting, moving, sharing, installing skills, other commands, and non-OpenKnowledge file edits still ask. Cursor, OpenCode, and Pi are unaffected. Best-effort per agent.`}
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
