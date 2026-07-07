/**
 * Install subscribers for the desktop version-drift + restart bridge events.
 *
 * On `ok:server-version-drift` (this window attached to a server whose version
 * differs from the app — typically a prior version's detached server still
 * alive after an auto-update), surface a persistent, cancelable sonner toast
 * with a "Restart with this app's version" action. The action restarts the
 * server via the bridge; on success main recreates the window, so the success
 * confirmation arrives on the NEW window via `ok:server-restarted` and only a
 * failure resolves back here (showing the branched remedy).
 *
 * On `ok:server-reclaimed` (a dev-only session auto-terminated a foreign server
 * on this project's contentDir and spawned its own — see the window-manager
 * reclaim branch), surface a transient warning naming the dropped-MCP side
 * effect. No user action initiated it, so it informs rather than confirms.
 *
 * Registered imperatively during `main.tsx` module init (not in a React
 * effect) so the listeners are in place before main fires the events on
 * `dom-ready` / `did-finish-load`. No-op in web / CLI distribution
 * (`window.okDesktop` undefined).
 *
 * User-facing copy is wrapped in the Lingui `t` macro inside functions (never
 * at module top level) so each string resolves against the active locale at
 * call time. This module has no React context, so it relies on the global
 * `i18n` singleton activated by `@/lib/i18n` — imported before this listener in
 * `main.tsx`, and active well before any bridge event fires at runtime.
 */

import { t } from '@lingui/core/macro';
import { createElement } from 'react';
import { toast } from 'sonner';
import { ServerDriftToast } from '@/components/ServerDriftToast';
import type {
  OkDesktopBridge,
  OkServerRestartOutcome,
  OkServerVersionDriftInfo,
} from '@/lib/desktop-bridge-types';

/**
 * Shared agent-disruption warning shown as the toast description. Names MCP
 * explicitly because that is how connected harnesses surface the drop
 * ("OpenKnowledge MCP connection closed unexpectedly"); the remedy mirrors
 * what those clients expose (restart the agent, or toggle the MCP off/on). A
 * function (not a const) so the `t` macro resolves at call time. Pure given the
 * active locale — exported for tests.
 */
export function restartDisruptionWarning(): string {
  return t`Restarting closes this project's server. Connected agents (Claude Code, Codex, Cursor) will see their OpenKnowledge MCP connection close unexpectedly — you may need to restart the agent, or toggle its OpenKnowledge MCP server off and on, to reconnect.`;
}

/** Direction-aware lead sentence for the drift toast. Pure — exported for tests. */
export function driftToastBody(info: OkServerVersionDriftInfo): string {
  // The protocol version can bump without a semver bump, so the two runtime
  // versions can be equal while the build is still incompatible. Avoid the
  // confusing "older version (v0.8.2) than this app (v0.8.2)" by not citing
  // identical numbers in that case.
  if (info.serverRuntime === info.appRuntime) {
    return t`This project is running a different, incompatible build of OpenKnowledge than this app (v${info.appRuntime}).`;
  }
  return info.relation === 'older'
    ? t`This project is running an older version of OpenKnowledge (v${info.serverRuntime}) than this app (v${info.appRuntime}).`
    : t`This project's server (v${info.serverRuntime}) is newer than this app (v${info.appRuntime}).`;
}

/** Success confirmation shown on the recreated window. Pure — exported for tests. */
export function restartSuccessMessage(appRuntime: string): string {
  return t`Restarted — now running v${appRuntime}.`;
}

/**
 * Disruption notice shown on the freshly-spawned window after a dev session
 * auto-reclaimed a foreign server (act-then-inform — no user action initiated
 * it, so this informs rather than confirms). Names the dropped-MCP side effect
 * with the same remedy as {@link restartDisruptionWarning} so a dev who sees
 * their agents disconnect understands they caused it by launching this build.
 * Pure — exported for tests.
 */
export function reclaimNoticeMessage(appRuntime: string): string {
  return t`Started a fresh OpenKnowledge server (v${appRuntime}) for this dev session — the server already running for this project was terminated. Connected agents (Claude Code, Codex, Cursor) just lost their OpenKnowledge MCP connection; restart the agent, or toggle its OpenKnowledge MCP server off and on, to reconnect.`;
}

/**
 * Branched failure copy. EPERM means a different user owns the server, so the
 * user's own `ok stop all` would hit the same wall — the only remedy is a
 * reboot. Other failures (wedged process) can plausibly be cleared with
 * `ok stop all`. Pure — exported for tests.
 */
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
    // On success main tears down this window, so the invoke can reject as the
    // IPC channel closes — that IS the success path, not an error. The new
    // window's `ok:server-restarted` provides the confirmation. Leave the
    // loading toast; it dies with the window.
    return;
  }
  // The invoke resolved. In the normal flow this only happens on failure
  // (success recreates the originating window), but don't rely on that — clear
  // the loading toast on any resolved outcome so a success that reaches a still-
  // live renderer can't strand it. Show the remedy only on failure.
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
    // Render a custom layout (see ServerDriftToast) rather than sonner's
    // built-in action/cancel/description, which collapses the text column with
    // long copy + two buttons. `toast.custom` hands us the id so the buttons
    // can dismiss this specific toast. The `t` macro calls resolve here, inside
    // the event callback, so the copy reflects the active locale at fire time.
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

  // Dev-only: main auto-reclaimed a foreign server and spawned its own. Inform
  // (don't confirm) — `warning`, and a generous-but-finite duration so the
  // multi-sentence side-effect copy is readable without piling up on repeat
  // dev launches. Fires only when a reclaim actually happened (a leftover
  // server was present), not on every launch.
  const unsubscribeReclaimed = bridge.onServerReclaimed((info) => {
    toast.warning(reclaimNoticeMessage(info.appRuntime), { duration: 15_000 });
  });

  return () => {
    unsubscribeDrift();
    unsubscribeRestarted();
    unsubscribeReclaimed();
  };
}
