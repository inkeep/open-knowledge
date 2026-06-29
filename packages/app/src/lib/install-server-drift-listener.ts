
import { t } from '@lingui/core/macro';
import { createElement } from 'react';
import { toast } from 'sonner';
import { ServerDriftToast } from '@/components/ServerDriftToast';
import type {
  OkDesktopBridge,
  OkServerRestartOutcome,
  OkServerVersionDriftInfo,
} from '@/lib/desktop-bridge-types';

export function restartDisruptionWarning(): string {
  return t`Restarting closes this project's server. Connected agents (Claude Code, Codex, Cursor) will see their OpenKnowledge MCP connection close unexpectedly — you may need to restart the agent, or toggle its OpenKnowledge MCP server off and on, to reconnect.`;
}

export function driftToastBody(info: OkServerVersionDriftInfo): string {
  if (info.serverRuntime === info.appRuntime) {
    return t`This project is running a different, incompatible build of OpenKnowledge than this app (v${info.appRuntime}).`;
  }
  return info.relation === 'older'
    ? t`This project is running an older version of OpenKnowledge (v${info.serverRuntime}) than this app (v${info.appRuntime}).`
    : t`This project's server (v${info.serverRuntime}) is newer than this app (v${info.appRuntime}).`;
}

export function restartSuccessMessage(appRuntime: string): string {
  return t`Restarted — now running v${appRuntime}.`;
}

export function reclaimNoticeMessage(appRuntime: string): string {
  return t`Started a fresh OpenKnowledge server (v${appRuntime}) for this dev session — the server already running for this project was terminated. Connected agents (Claude Code, Codex, Cursor) just lost their OpenKnowledge MCP connection; restart the agent, or toggle its OpenKnowledge MCP server off and on, to reconnect.`;
}

export function restartFailureMessage(reason: 'eperm' | 'other'): string {
  return reason === 'eperm'
    ? t`Couldn't restart the server — it's running under a different account. Restart your computer to clear it, then reopen this project.`
    : t`Couldn't restart the server automatically. Try running \`ok stop all\` in a terminal, then reopen this project — or restart your computer if it persists.`;
}

async function runRestart(bridge: OkDesktopBridge): Promise<void> {
  const loadingId = toast.loading(t`Restarting the server…`, {
    duration: Number.POSITIVE_INFINITY,
  });
  let outcome: OkServerRestartOutcome;
  try {
    outcome = await bridge.restartServer(bridge.config.projectPath);
  } catch {
    return;
  }
  toast.dismiss(loadingId);
  if (outcome.ok === false) {
    toast.error(restartFailureMessage(outcome.reason), {
      duration: Number.POSITIVE_INFINITY,
    });
  }
}

export function installServerDriftListener(opts: {
  bridge: OkDesktopBridge | undefined;
}): (() => void) | undefined {
  const bridge = opts.bridge;
  if (!bridge) return undefined;

  const unsubscribeDrift = bridge.onServerVersionDrift((info) => {
    toast.custom(
      (id) =>
        createElement(ServerDriftToast, {
          body: driftToastBody(info),
          warning: restartDisruptionWarning(),
          restartLabel: t`Restart with this app's version`,
          cancelLabel: t`Not now`,
          onRestart: () => {
            toast.dismiss(id);
            void runRestart(bridge);
          },
          onDismiss: () => toast.dismiss(id),
        }),
      { duration: Number.POSITIVE_INFINITY },
    );
  });

  const unsubscribeRestarted = bridge.onServerRestarted((info) => {
    toast.success(restartSuccessMessage(info.appRuntime));
  });

  const unsubscribeReclaimed = bridge.onServerReclaimed((info) => {
    toast.warning(reclaimNoticeMessage(info.appRuntime), { duration: 15_000 });
  });

  return () => {
    unsubscribeDrift();
    unsubscribeRestarted();
    unsubscribeReclaimed();
  };
}
