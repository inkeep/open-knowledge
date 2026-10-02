import {
  type AgentId,
  agentIdForHandoffTarget,
  type HandoffOutcome,
  type HandoffTarget,
  KNOWN_HANDOFF_TARGETS,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import {
  type AgentConnection,
  type ApplyConnections,
  ConfigureConnectionDialog,
  connectionsFromSnapshot,
  hasPairedConnectionRows,
  intentsForParts,
} from '@/components/settings/AgentConnectionDialogs';
import { deriveRowConnectionStatus } from '@/components/settings/agent-connection-status';
import {
  type ApplyAgentConnectionsResult,
  applyAgentConnectionIntents,
} from '@/lib/agent-connections';
import { loadBoolPref, saveBoolPref } from '@/lib/bool-pref';
import { recordHandoff } from '@/lib/handoff/telemetry';
import { scopedStorageKey } from '@/lib/storage-scope';
import type { HandoffDispatchOptions } from './useHandoffDispatch';

type RawHandoffDispatch = () => Promise<HandoffOutcome>;

interface PendingHandoff {
  readonly id: number;
  readonly target: HandoffTarget;
  readonly projectDir: string;
  readonly rawDispatch: RawHandoffDispatch;
  readonly returnFocus: HTMLElement | null;
  readonly restoreFocus: (() => void) | undefined;
  readonly resolve: (outcome: HandoffOutcome) => void;
  readonly reject: (reason?: unknown) => void;
  readonly check: {
    readonly controller: AbortController;
    statusTimer: ReturnType<typeof setTimeout> | null;
    deadlineTimer: ReturnType<typeof setTimeout> | null;
  };
}

type GateState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'checking';
      readonly id: number;
      readonly target: HandoffTarget;
      readonly visible: boolean;
    }
  | {
      readonly kind: 'setup';
      readonly pending: PendingHandoff;
      readonly connection: AgentConnection;
    };

interface ExternalHandoffGateDispatchOptions extends HandoffDispatchOptions {
  readonly projectDir: string;
}

interface ExternalHandoffGateValue {
  dispatch: (
    target: HandoffTarget,
    rawDispatch: RawHandoffDispatch,
    options: ExternalHandoffGateDispatchOptions,
  ) => Promise<HandoffOutcome>;
}

const ExternalHandoffGateContext = createContext<ExternalHandoffGateValue | null>(null);
const DISMISSED_SETUP_KEY = 'ok-external-handoff-setup-dismissed-v1';
const CHECK_STATUS_DELAY_MS = 250;
const CHECK_DEADLINE_MS = 10_000;

type ExternalReadiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'setup'; readonly connection: AgentConnection }
  | {
      readonly kind: 'unknown';
      readonly cause:
        | 'unavailable'
        | 'read-failed'
        | 'missing-snapshot'
        | 'unknown-status'
        | 'missing-row';
      readonly detail?: string;
    };

type ReadinessBypassCause =
  | 'unmapped-target'
  | 'read-threw'
  | 'read-timeout'
  | 'check-threw'
  | 'derivation-threw'
  | Extract<ExternalReadiness, { readonly kind: 'unknown' }>['cause'];

function diagnosticDetail(value: unknown): string | undefined {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : null;
  const normalized = raw?.replace(/\s+/g, ' ').trim().slice(0, 240);
  return normalized || undefined;
}

function warnReadinessBypass(
  target: HandoffTarget,
  cause: ReadinessBypassCause,
  rawDetail?: unknown,
): void {
  const detail = diagnosticDetail(rawDetail);
  console.warn('[handoff] external readiness check bypassed', {
    target,
    cause,
    ...(detail === undefined ? {} : { detail }),
  });
}

function stopCheck(pending: PendingHandoff): void {
  const { check } = pending;
  if (check.statusTimer !== null) clearTimeout(check.statusTimer);
  if (check.deadlineTimer !== null) clearTimeout(check.deadlineTimer);
  check.statusTimer = null;
  check.deadlineTimer = null;
  check.controller.abort();
}

function settleWithoutDispatch(
  pending: PendingHandoff,
  reason: 'setup-canceled' | 'superseded',
): void {
  recordWithoutDispatch(pending.target, reason);
  pending.resolve({ ok: false, reason });
}

function recordWithoutDispatch(
  target: HandoffTarget,
  reason: 'not-installed' | 'setup-canceled' | 'superseded',
): void {
  void recordHandoff({
    target,
    host: typeof window !== 'undefined' && window.okDesktop != null ? 'electron' : 'web',
    outcome: 'error',
    reason,
    ts: new Date().toISOString(),
  });
}

function externalReadiness(
  agentId: AgentId,
  result: ApplyAgentConnectionsResult,
): ExternalReadiness {
  if (result.unavailable === true)
    return { kind: 'unknown', cause: 'unavailable', detail: result.error };
  if (!result.ok) return { kind: 'unknown', cause: 'read-failed', detail: result.error };
  if (result.snapshot === null) return { kind: 'unknown', cause: 'missing-snapshot' };
  const status = deriveRowConnectionStatus({
    agentId,
    mode: 'external',
    snapshot: result.snapshot,
    detected: true,
  });
  if (status === 'connected') return { kind: 'ready' };
  if (status !== 'not-connected')
    return { kind: 'unknown', cause: 'unknown-status', detail: status };

  const connection = connectionsFromSnapshot(result.snapshot, {
    forceDetected: [agentId],
  }).find((entry) => entry.id === agentId);
  return connection === undefined
    ? { kind: 'unknown', cause: 'missing-row' }
    : { kind: 'setup', connection };
}

function activeHTMLElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let active = document.activeElement;
  while (active instanceof HTMLElement) {
    const nested = active.shadowRoot?.activeElement;
    if (!(nested instanceof HTMLElement)) break;
    active = nested;
  }
  return active instanceof HTMLElement ? active : null;
}

function setupPreferenceKey(target: HandoffTarget, projectDir: string): string {
  return `${scopedStorageKey(DISMISSED_SETUP_KEY, projectDir)}:${target}`;
}

export function setupPromptDismissed(target: HandoffTarget, projectDir: string): boolean {
  return loadBoolPref(setupPreferenceKey(target, projectDir));
}

export function setSetupPromptDismissed(
  target: HandoffTarget,
  projectDir: string,
  dismissed: boolean,
): void {
  saveBoolPref(setupPreferenceKey(target, projectDir), dismissed);
}

export function ExternalHandoffGateProvider({
  children,
  applyConnections = applyAgentConnectionIntents,
}: {
  children: ReactNode;
  applyConnections?: ApplyConnections;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<GateState>({ kind: 'idle' });
  const [rememberSkip, setRememberSkip] = useState(false);
  const activeRef = useRef<PendingHandoff | null>(null);
  const requestVersion = useRef(0);

  function isActive(pending: PendingHandoff): boolean {
    return activeRef.current?.id === pending.id;
  }

  function detach(pending: PendingHandoff): boolean {
    if (!isActive(pending)) return false;
    activeRef.current = null;
    stopCheck(pending);
    setState({ kind: 'idle' });
    return true;
  }

  useEffect(
    () => () => {
      const pending = activeRef.current;
      if (pending === null) return;
      activeRef.current = null;
      stopCheck(pending);
      settleWithoutDispatch(pending, 'superseded');
    },
    [],
  );

  function cancel(pending: PendingHandoff): void {
    if (!detach(pending)) return;
    settleWithoutDispatch(pending, 'setup-canceled');
  }

  function runReady(pending: PendingHandoff): void {
    if (!detach(pending)) return;
    void Promise.resolve().then(pending.rawDispatch).then(pending.resolve, pending.reject);
  }

  function refreshReturnFocus(pending: PendingHandoff): PendingHandoff {
    const activeElement = activeHTMLElement();
    if (activeElement === null || activeElement === document.body || !activeElement.isConnected) {
      return pending;
    }
    const refreshed = { ...pending, returnFocus: activeElement };
    activeRef.current = refreshed;
    return refreshed;
  }

  async function check(pending: PendingHandoff): Promise<void> {
    const agentId = agentIdForHandoffTarget(pending.target);
    if (agentId === undefined) {
      warnReadinessBypass(pending.target, 'unmapped-target');
      runReady(pending);
      return;
    }

    let result: ApplyAgentConnectionsResult;
    try {
      result = await applyConnections([], { webSignal: pending.check.controller.signal });
    } catch (error) {
      if (!isActive(pending)) return;
      warnReadinessBypass(pending.target, 'read-threw', error);
      runReady(pending);
      return;
    }
    if (!isActive(pending)) return;
    let readiness: ExternalReadiness;
    try {
      readiness = externalReadiness(agentId, result);
    } catch (error) {
      warnReadinessBypass(pending.target, 'derivation-threw', error);
      runReady(pending);
      return;
    }
    if (readiness.kind !== 'setup') {
      if (readiness.kind === 'unknown') {
        warnReadinessBypass(pending.target, readiness.cause, readiness.detail);
      }
      runReady(pending);
      return;
    }
    stopCheck(pending);
    setRememberSkip(false);
    setState({
      kind: 'setup',
      pending: refreshReturnFocus(pending),
      connection: readiness.connection,
    });
  }

  function dispatch(
    target: HandoffTarget,
    rawDispatch: RawHandoffDispatch,
    options: ExternalHandoffGateDispatchOptions,
  ): Promise<HandoffOutcome> {
    const superseded = activeRef.current;
    if (superseded !== null && detach(superseded)) {
      settleWithoutDispatch(superseded, 'superseded');
    }

    const id = ++requestVersion.current;
    if (options.installState.installed === false) {
      recordWithoutDispatch(target, 'not-installed');
      return Promise.resolve({ ok: false, reason: 'not-installed' });
    }
    return new Promise<HandoffOutcome>((resolve, reject) => {
      const activeElement = activeHTMLElement();
      const pending: PendingHandoff = {
        id,
        target,
        projectDir: options.projectDir,
        rawDispatch,
        returnFocus: activeElement?.tagName === 'BODY' ? null : activeElement,
        restoreFocus: options.restoreFocus,
        resolve,
        reject,
        check: {
          controller: new AbortController(),
          statusTimer: null,
          deadlineTimer: null,
        },
      };
      activeRef.current = pending;
      if (setupPromptDismissed(target, options.projectDir)) {
        runReady(pending);
        return;
      }
      setState({ kind: 'checking', id, target, visible: false });
      pending.check.statusTimer = setTimeout(() => {
        if (!isActive(pending)) return;
        setState((current) =>
          current.kind === 'checking' && current.id === id
            ? { ...current, visible: true }
            : current,
        );
      }, CHECK_STATUS_DELAY_MS);
      pending.check.deadlineTimer = setTimeout(() => {
        if (!isActive(pending)) return;
        warnReadinessBypass(pending.target, 'read-timeout');
        runReady(pending);
      }, CHECK_DEADLINE_MS);
      void check(pending).catch((error) => {
        if (!isActive(pending)) return;
        warnReadinessBypass(pending.target, 'check-threw', error);
        runReady(pending);
      });
    });
  }

  const setupState = state.kind === 'setup' ? state : null;
  const handoffLabel = setupState?.connection.label ?? '';
  const checkingLabel =
    state.kind === 'checking'
      ? (KNOWN_HANDOFF_TARGETS.find((target) => target.id === state.target)?.displayName ??
        state.target)
      : '';

  return (
    <ExternalHandoffGateContext value={{ dispatch }}>
      {children}
      {state.kind === 'checking' && state.visible ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground shadow-md"
        >
          {t`Checking connection to ${checkingLabel}…`}
        </div>
      ) : null}
      {setupState !== null ? (
        <ConfigureConnectionDialog
          key={setupState.pending.id}
          connection={setupState.connection}
          paired={hasPairedConnectionRows(setupState.connection.id)}
          open
          onOpenChange={(open) => {
            if (!open) cancel(setupState.pending);
          }}
          onCloseAutoFocus={(event) => {
            const returnFocus = setupState.pending.returnFocus;
            if (returnFocus?.isConnected === true) {
              event.preventDefault();
              returnFocus.focus();
            } else if (setupState.pending.restoreFocus !== undefined) {
              event.preventDefault();
              setupState.pending.restoreFocus();
            }
          }}
          validateSave={(parts) =>
            parts.projectMcp || parts.globalMcp
              ? null
              : t`To save this setup, turn on Project MCP server or Global MCP server.`
          }
          alternateAction={{
            label: t`Open ${handoffLabel}`,
            onClick: () => {
              if (rememberSkip) {
                setSetupPromptDismissed(
                  setupState.pending.target,
                  setupState.pending.projectDir,
                  true,
                );
              }
              runReady(setupState.pending);
            },
            preference: {
              checked: rememberSkip,
              label: t`Don't ask again when opening this app without setup in this project`,
              onCheckedChange: setRememberSkip,
            },
          }}
          onSave={async (parts, alsoRemove) => {
            const result = await applyConnections(
              intentsForParts(setupState.connection, parts, alsoRemove),
            );
            if (!isActive(setupState.pending)) return result;
            if (!result.ok) return result;
            let readiness: ExternalReadiness;
            try {
              readiness = externalReadiness(setupState.connection.id, result);
            } catch (error) {
              warnReadinessBypass(setupState.pending.target, 'derivation-threw', error);
              return {
                kind: 'saved-not-ready',
                message: t`Changes were saved, but OpenKnowledge could not confirm a connection to ${handoffLabel}. Check the MCP server settings for this app, then select Save changes to check again.`,
              };
            }
            if (readiness.kind !== 'ready') {
              return {
                kind: 'saved-not-ready',
                message: t`Changes were saved, but OpenKnowledge could not confirm a connection to ${handoffLabel}. Check the MCP server settings for this app, then select Save changes to check again.`,
              };
            }
            runReady(setupState.pending);
            return result;
          }}
        />
      ) : null}
    </ExternalHandoffGateContext>
  );
}

export function useExternalHandoffGate(): ExternalHandoffGateValue {
  const value = use(ExternalHandoffGateContext);
  if (value === null) {
    throw new Error('useExternalHandoffGate must be used within <ExternalHandoffGateProvider />');
  }
  return value;
}
