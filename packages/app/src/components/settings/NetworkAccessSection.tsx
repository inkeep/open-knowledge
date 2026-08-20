/**
 * Settings → This project → Remote control (desktop-only).
 *
 * The GUI for exposing this Desktop's loopback project server over a user-run
 * tunnel (Tailscale, a reverse proxy, a VPN). It writes the two config leaves
 * the server boot reads, then restarts the project server:
 *
 *  - `server.allowExternal` (project-LOCAL, gitignored) — the exposure consent
 *    the boot interlock requires. Per-machine: never travels via clone/share.
 *  - `server.externalUrl` + `server.port` (project scope) — the public origin
 *    the Host-gate admits, and a pinned port so the tunnel's fixed target stays
 *    stable across restarts.
 *
 * BOTH are needed to expose: an origin without consent is inert (no exposure),
 * consent without an origin admits no external Host (every request 403s). The
 * tunnel itself is the user's — OK provisions nothing and runs no server-side
 * auth (the edge owns it), and OK does not detect, prefill, or drive the tunnel:
 * the setup how-to lives in the docs (a docs link lands once the docs rename
 * deploys). The pane never writes
 * `server.bind`, so a normal project binds loopback and the tunnel forwards to
 * it; a non-loopback bind that arrived via committed config still binds only
 * under the boot exposure interlock, which refuses a wide bind without the
 * consent this pane writes — which is also why a loopback port probe is the
 * right surface to preflight here. Scope split is locked: consent is
 * project-local, origin + port are committed project scope (inert without the
 * local consent).
 */
import { DEFAULT_TUNNEL_PORT, humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useConfigContext } from '@/lib/config-provider';
import { restartCollabServer } from '@/lib/restart-collab-server';
import { SettingsSectionHeader } from './SettingsSectionHeader';

type PortMode = 'auto' | 'fixed';

export function NetworkAccessSection() {
  const { t } = useLingui();
  const {
    projectConfig,
    projectSynced,
    projectBinding,
    projectLocalConfig,
    projectLocalSynced,
    projectLocalBinding,
  } = useConfigContext();

  // Consent is project-local; origin + port are committed project scope. We
  // read each field only from the scope that owns it — never surface a
  // committed allowExternal (it is always inert per the clone-leak guard, so
  // display = what actually boots).
  const configuredAllow = projectLocalConfig?.server?.allowExternal === true;
  const configuredOrigin = projectConfig?.server?.externalUrl ?? '';
  const configuredPort = projectConfig?.server?.port;

  const [expose, setExpose] = useState(configuredAllow);
  const [origin, setOrigin] = useState(configuredOrigin);
  const [portMode, setPortMode] = useState<PortMode>(configuredPort != null ? 'fixed' : 'auto');
  const [portDraft, setPortDraft] = useState(
    configuredPort != null ? String(configuredPort) : String(DEFAULT_TUNNEL_PORT),
  );
  const [originError, setOriginError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  // Preflight availability of the typed fixed port: true (bindable), false (held
  // by another process), or null (not checked / unknown / no desktop bridge).
  const [portAvailable, setPortAvailable] = useState<boolean | null>(null);

  // Re-seed the drafts when the persisted values change out from under us — a
  // `ok config` edit in a terminal while Settings is open, or the first sync
  // after mount. "Adjust state during render on a changed value" (no effect).
  const [prevConfigured, setPrevConfigured] = useState({
    allow: configuredAllow,
    origin: configuredOrigin,
    port: configuredPort,
  });
  if (
    prevConfigured.allow !== configuredAllow ||
    prevConfigured.origin !== configuredOrigin ||
    prevConfigured.port !== configuredPort
  ) {
    setPrevConfigured({ allow: configuredAllow, origin: configuredOrigin, port: configuredPort });
    setExpose(configuredAllow);
    setOrigin(configuredOrigin);
    setPortMode(configuredPort != null ? 'fixed' : 'auto');
    setPortDraft(configuredPort != null ? String(configuredPort) : String(DEFAULT_TUNNEL_PORT));
    setOriginError(null);
    setPortError(null);
    // Drop the stale probe verdict too — it was measured against the old draft.
    setPortAvailable(null);
  }

  const bindingsReady =
    projectSynced && projectLocalSynced && projectBinding !== null && projectLocalBinding !== null;

  // Surface a pinned-port fallback: if a fixed `server.port` is configured but
  // the server actually bound a different port (EADDRINUSE → ephemeral fallback
  // in the utility boot), a tunnel forwarding to the fixed port reaches nothing.
  // The bound port is the one this window is talking to, read off the desktop
  // bridge's apiOrigin — no extra IPC needed.
  const boundPort = (() => {
    const apiOrigin = window.okDesktop?.config?.apiOrigin;
    if (!apiOrigin) return null;
    try {
      const p = new URL(apiOrigin).port;
      return p === '' ? null : Number(p);
    } catch {
      return null;
    }
  })();
  const portInUse = configuredPort != null && boundPort != null && boundPort !== configuredPort;

  // Exposing pins the port: a tunnel forwards to a fixed target, so an
  // ephemeral port would break it on every restart.
  const effectivePortMode: PortMode = expose ? 'fixed' : portMode;

  // Preflight probe: when a fixed port is typed, ask main whether it is bindable
  // so the user learns "that port is taken" BEFORE Apply, not after a silent
  // ephemeral fallback. The port we are already bound to counts as available —
  // it is ours, and a restart rebinds it. Debounced so typing doesn't spam it.
  useEffect(() => {
    const probe = window.okDesktop?.remoteAccess?.probePort;
    const raw = portDraft.trim();
    const port = Number(raw);
    const valid = effectivePortMode === 'fixed' && /^\d+$/.test(raw) && port >= 1 && port <= 65535;
    if (!probe || !valid) {
      setPortAvailable(null);
      return;
    }
    if (port === boundPort) {
      setPortAvailable(true);
      return;
    }
    // Clear the previous port's verdict immediately so a stale "available" (or
    // "in use") never renders against the new draft during the debounce window —
    // otherwise a fast edit from a free port to a taken one could be applied
    // before the fresh probe resolves.
    setPortAvailable(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      probe(port)
        .then((ok) => {
          if (!cancelled) setPortAvailable(ok);
        })
        .catch((err: unknown) => {
          // Fail-open (null → Apply not blocked), but leave a breadcrumb: a
          // silent probe failure (unregistered handler, packaging skew) would
          // otherwise be undiagnosable.
          console.warn('[remote-access] port probe failed:', err);
          if (!cancelled) setPortAvailable(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [portDraft, effectivePortMode, boundPort]);

  function originProblem(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return t`Enter the public origin your tunnel serves, for example https://notes.example.com`;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return t`Enter a valid URL, for example https://notes.example.com`;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return t`Use an http:// or https:// origin.`;
    }
    return null;
  }

  function portProblem(value: string): string | null {
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return t`Enter a port between 1 and 65535.`;
    }
    return null;
  }

  const portChanged =
    effectivePortMode === 'fixed'
      ? Number(portDraft.trim()) !== configuredPort
      : configuredPort != null;
  const dirty =
    expose !== configuredAllow || (expose && origin.trim() !== configuredOrigin) || portChanged;

  // The typed fixed port is known-taken by another process — the preflight probe
  // came back negative. `null` (probe pending / no bridge) does NOT flag —
  // fail-open. This is the display signal for the "in use" line.
  const portUnavailable =
    effectivePortMode === 'fixed' && portError === null && portAvailable === false;
  // Block Apply on a taken port ONLY while exposing — applying an exposed config
  // on a taken port lets boot fall back to an ephemeral port and defeats the
  // pinned tunnel target. Never block the disable path (`expose` false): a user
  // stuck in the fallback state must always be able to turn exposure back off to
  // recover, even when the old port is still held.
  const portTaken = portUnavailable && expose;
  // The pre-Apply "in use" line is redundant with the post-Apply "running on X
  // instead" banner when the draft is the very port that already fell back — show
  // only one for that case (the post-Apply banner, which names the real port).
  const probeUnavailableRedundant =
    portInUse && Number(portDraft.trim()) === configuredPort && !applying;

  function validate(): boolean {
    let ok = true;
    if (expose) {
      const problem = originProblem(origin);
      setOriginError(problem);
      if (problem !== null) ok = false;
    } else {
      setOriginError(null);
    }
    if (effectivePortMode === 'fixed') {
      const problem = portProblem(portDraft);
      setPortError(problem);
      if (problem !== null) ok = false;
    } else {
      setPortError(null);
    }
    return ok;
  }

  async function doApply(): Promise<void> {
    if (projectBinding === null || projectLocalBinding === null) {
      toast.error(t`Network settings not yet loaded. Try again in a moment.`);
      return;
    }
    setApplying(true);

    const port = effectivePortMode === 'fixed' ? Number(portDraft.trim()) : null;
    const originValue = expose ? origin.trim() : null;
    // `null` clears the leaf (yaml-patch deleteIn); a scalar sets it.
    const runProject = () => projectBinding.patch({ server: { externalUrl: originValue, port } });
    const runConsent = () => projectLocalBinding.patch({ server: { allowExternal: expose } });

    // Fail-safe ordering. Enabling: write origin/port FIRST, consent LAST — a
    // committed origin without consent is inert, so a mid-way failure never
    // exposes anything. Disabling: drop consent FIRST so exposure is removed
    // immediately, even if the origin/port write then fails.
    const first = expose ? runProject() : runConsent();
    if (!first.ok) {
      toast.error(t`Couldn't save network settings. ${humanFormat(first.error)}`);
      setApplying(false);
      return;
    }
    const second = expose ? runConsent() : runProject();
    if (!second.ok) {
      if (expose) {
        // Enable path: origin/port committed but consent (the second write) did
        // not, so nothing is exposed — stop here.
        toast.error(t`Couldn't save network settings. ${humanFormat(second.error)}`);
        setApplying(false);
        return;
      }
      // Disable path: consent was already dropped (first write), so a restart
      // still removes exposure even though clearing the origin failed. Warn, then
      // fall through to the restart so exposure actually stops.
      toast.error(
        t`Couldn't fully clear network settings, but exposure is turning off. ${humanFormat(second.error)}`,
      );
    }

    const bridge = window.okDesktop;
    if (!bridge) {
      toast.error(t`Restarting the server is only available in the desktop app.`);
      setApplying(false);
      return;
    }
    // On success the main process tears this window down and recreates it, so
    // the awaited call may reject or never resolve — that IS the success path.
    // Only a resolved failure is actionable here. Catch the rejection so an
    // unexpected IPC error re-enables the button (on the success path the
    // component is unmounting, so the state update is a harmless no-op) instead
    // of leaking an unhandled rejection and stranding "Applying…".
    try {
      const result = await restartCollabServer(bridge);
      if (!result.ok) {
        toast.error(result.message);
        setApplying(false);
      }
    } catch (err) {
      setApplying(false);
      // Discriminate the success-path window teardown (the IPC rejects because
      // main tore this window down) from a genuine IPC failure. On a real error
      // the config already committed to disk but the server did not restart, so
      // surface it instead of a silent re-enable. Same teardown signature the
      // preload's `isDockStateIpcTeardown` filters on.
      const isWindowTeardown =
        err instanceof Error &&
        /destroyed|disposed|closed|no handler registered/i.test(err.message);
      if (!isWindowTeardown) {
        // Highest-impact failure in this flow — config already on disk, server
        // never restarted. Renderer React is exempt from pino, so console it.
        console.warn(
          '[remote-access] restart IPC failed (config committed, server not restarted):',
          err,
        );
        toast.error(t`Couldn't restart the server. Run ok start in this folder to retry.`);
      }
    }
  }

  function onApply(): void {
    if (!validate()) return;
    // Enabling exposure is consequential and auth-free — confirm the off→on
    // consent transition. Edits while already exposed, and disabling, apply
    // straight away.
    if (expose && !configuredAllow) {
      setConfirmOpen(true);
      return;
    }
    void doApply();
  }

  function onConfirm(): void {
    setConfirmOpen(false);
    void doApply();
  }

  return (
    <section aria-labelledby="settings-network-access-title" className="space-y-3">
      <SettingsSectionHeader titleId="settings-network-access-title" title={t`Remote control`} beta>
        {t`Expose this project over a tunnel you run to reach its editor and agent endpoint from your other devices.`}
      </SettingsSectionHeader>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div className="space-y-0.5">
          <label htmlFor="settings-network-expose-toggle" className="text-sm font-medium">
            {t`Allow external access`}
          </label>
          <p
            id="settings-network-expose-body"
            className="text-1sm text-muted-foreground"
            data-testid="settings-network-expose-body"
          >
            {t`This server has no built-in authentication. Anyone who can reach the tunnel gets full control of this knowledge base. Put an authenticating gate in front, such as a private Tailscale network or a reverse proxy with authentication.`}
          </p>
        </div>
        <Switch
          id="settings-network-expose-toggle"
          checked={expose}
          onCheckedChange={setExpose}
          disabled={!bindingsReady || applying}
          aria-describedby="settings-network-expose-body"
          data-testid="settings-network-expose-toggle"
        />
      </div>

      {expose ? (
        <div className="space-y-1.5 rounded-md border p-3">
          <Label htmlFor="settings-network-origin" className="text-sm font-medium">
            {t`External origin`}
          </Label>
          <p id="settings-network-origin-desc" className="text-1sm text-muted-foreground">
            {t`The public URL your tunnel serves (for example your Tailscale https://…ts.net address). The server admits requests for this host and advertises it in the URLs it issues.`}
          </p>
          <Input
            id="settings-network-origin"
            value={origin}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://notes.example.com"
            onChange={(e) => {
              setOrigin(e.target.value);
              if (originError !== null) setOriginError(originProblem(e.target.value));
            }}
            disabled={!bindingsReady || applying}
            aria-invalid={originError !== null}
            aria-describedby={
              originError !== null
                ? 'settings-network-origin-desc settings-network-origin-error'
                : 'settings-network-origin-desc'
            }
            data-testid="settings-network-origin"
          />
          {originError !== null ? (
            <p
              id="settings-network-origin-error"
              className="text-1sm text-destructive"
              data-testid="settings-network-origin-error"
            >
              {originError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2 rounded-md border p-3">
        <div className="space-y-0.5">
          <span id="settings-network-port-label" className="text-sm font-medium">
            {t`Local server port`}
          </span>
          <p id="settings-network-port-mode-desc" className="text-1sm text-muted-foreground">
            {expose
              ? t`Exposing pins a fixed port so the tunnel's target stays stable across restarts.`
              : t`Automatic picks a free port each start. Choose a fixed port to keep the same address across restarts.`}
          </p>
        </div>
        <RadioGroup
          value={effectivePortMode}
          onValueChange={(v) => setPortMode(v as PortMode)}
          className="gap-2"
          aria-labelledby="settings-network-port-label"
          aria-describedby="settings-network-port-mode-desc"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem
              value="auto"
              id="settings-network-port-auto"
              disabled={expose || !bindingsReady || applying}
              data-testid="settings-network-port-auto"
            />
            <Label htmlFor="settings-network-port-auto" className="text-sm font-normal">
              {t`Automatic`}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem
              value="fixed"
              id="settings-network-port-fixed"
              disabled={!bindingsReady || applying}
              data-testid="settings-network-port-fixed"
            />
            <Label htmlFor="settings-network-port-fixed" className="text-sm font-normal">
              {t`Fixed`}
            </Label>
            <Input
              value={portDraft}
              inputMode="numeric"
              className="h-8 w-24"
              onChange={(e) => {
                setPortDraft(e.target.value);
                if (portError !== null) setPortError(portProblem(e.target.value));
              }}
              disabled={effectivePortMode !== 'fixed' || !bindingsReady || applying}
              aria-label={t`Fixed port number`}
              aria-invalid={portError !== null || portUnavailable}
              aria-describedby={
                portError !== null
                  ? 'settings-network-port-error'
                  : portUnavailable && !probeUnavailableRedundant
                    ? 'settings-network-port-unavailable'
                    : probeUnavailableRedundant
                      ? 'settings-network-port-inuse'
                      : undefined
              }
              data-testid="settings-network-port-input"
            />
          </div>
        </RadioGroup>
        {portError !== null ? (
          <p
            id="settings-network-port-error"
            className="text-1sm text-destructive"
            data-testid="settings-network-port-error"
          >
            {portError}
          </p>
        ) : null}
        {/* Preflight availability of the typed fixed port (advisory) — shown only
            when the field is otherwise valid and not the port we already run on. */}
        {portUnavailable && !probeUnavailableRedundant ? (
          <p
            id="settings-network-port-unavailable"
            role="alert"
            className="text-1sm text-destructive"
            data-testid="settings-network-port-unavailable"
          >
            {t`Port ${portDraft.trim()} is already in use by another process. Pick a different one so your tunnel target stays stable across restarts.`}
          </p>
        ) : null}
        {effectivePortMode === 'fixed' &&
        portError === null &&
        portAvailable === true &&
        Number(portDraft.trim()) !== boundPort ? (
          <p
            aria-live="polite"
            className="text-1sm text-muted-foreground"
            data-testid="settings-network-port-available"
          >
            {t`Port ${portDraft.trim()} is available.`}
          </p>
        ) : null}
        {/* Suppress both port banners while a restart is in flight: during
            Apply the config port already changed but the server (and this
            window's static apiOrigin) has not, so an unguarded compare flashes
            a false "port in use" even on a successful re-pin — the window is
            recreated on the new port moments later. */}
        {portInUse && !applying ? (
          <p
            id="settings-network-port-inuse"
            role="alert"
            className="text-1sm text-destructive"
            data-testid="settings-network-port-inuse"
          >
            {t`Port ${configuredPort} is in use, so the server is running on port ${boundPort} instead. A tunnel forwarding to the fixed port won't reach it. Free that port and apply again, or choose a different one.`}
          </p>
        ) : null}
        {configuredAllow && boundPort != null && !portInUse && !applying ? (
          <p
            aria-live="polite"
            className="text-1sm text-muted-foreground"
            data-testid="settings-network-serving"
          >
            {t`Hosting is on. The server is running on port ${boundPort}. Reach it through your tunnel.`}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-1sm text-muted-foreground">
          {t`Applying restarts this project's server.`}
        </p>
        <Button
          onClick={onApply}
          disabled={!bindingsReady || applying || portTaken || (!dirty && !portInUse)}
          data-testid="settings-network-apply"
        >
          {applying ? t`Applying…` : t`Apply and restart project server`}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="settings-network-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Expose this project to the network?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`The server will accept requests for ${origin.trim()} with no built-in authentication. Anyone who can reach your tunnel will have full control of this knowledge base, including sync, GitHub credentials, and local operations. Make sure the tunnel's edge restricts who can connect.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="settings-network-confirm-cancel">
              {t`Cancel`}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm} data-testid="settings-network-confirm-apply">
              {t`Expose and restart`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
