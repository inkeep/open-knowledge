/**
 * Settings → Terminal: the per-project opt-out toggle for the in-app real OS
 * shell.
 *
 * The terminal is available by default; this toggle is the silent opt-out. Reads
 * + writes the project-local `terminal.enabled` leaf (human-only —
 * `agentSettable:false`). On → off writes `false` (opt out, tearing down any
 * running shell via the gate); off → on writes `true` (re-enable). Only an
 * explicit `false` reads as off, so the toggle shows on for the default
 * (never-chosen) state.
 */
import { useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useTerminalConsentState, useTerminalEnabledWriter } from '@/hooks/use-terminal-enabled';

export function TerminalSection() {
  const { t } = useLingui();
  const { enabled, synced } = useTerminalConsentState();
  const writer = useTerminalEnabledWriter();
  const isOn = enabled !== false;

  function applyEnabled(next: boolean): void {
    if (writer === null) {
      toast.error(t`Terminal settings not loaded yet — try again in a moment.`);
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
    </section>
  );
}
