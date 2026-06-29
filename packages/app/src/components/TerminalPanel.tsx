import '@xterm/xterm/css/xterm.css';

import { buildCliLaunchCommand, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeReadiness, OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { cn } from '@/lib/utils';
import { ClaudeReadinessBanner } from './ClaudeReadinessBanner';
import type { TerminalLaunchIntent } from './EditorPane';
import { TerminalCliMissingBanner } from './TerminalCliMissingBanner';
import { type TerminalExitInfo, TerminalExitNotice } from './TerminalExitNotice';
import { TerminalRefusalNotice } from './TerminalRefusalNotice';
import { xtermThemeForMode } from './terminal-theme';
import { nextWheelReports, sgrWheelReport } from './terminal-wheel';

interface TerminalPanelProps {
  /** Desktop bridge — the panel is rendered only on the Electron host, where
   *  `window.okDesktop` is present. */
  readonly bridge: OkDesktopBridge;
  readonly className?: string;
  readonly onClose?: () => void;
  readonly onExit?: (info: { readonly exitCode: number; readonly signal: number | null }) => void;
  readonly onTitleChange?: (title: string) => void;
  readonly launch?: TerminalLaunchIntent | null;
  readonly adoptPtyId?: string | null;
}

export function TerminalPanel({
  bridge,
  className,
  onClose,
  onExit,
  onTitleChange,
  launch = null,
  adoptPtyId = null,
}: TerminalPanelProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const [restartKey, setRestartKey] = useState(0);
  const adoptForThisMount = restartKey === 0 ? adoptPtyId : null;
  return (
    <section
      aria-label={t`Terminal`}
      style={{ backgroundColor: xtermThemeForMode(resolvedTheme).background }}
      className={cn('relative flex h-full w-full flex-col overflow-hidden', className)}
    >
      {/* Positioning context for the session's absolute exit/refusal notices, so
          they cover the canvas area. */}
      <div className="relative min-h-0 flex-1">
        <TerminalSession
          key={restartKey}
          bridge={bridge}
          onClose={onClose}
          onExit={onExit}
          onTitleChange={onTitleChange}
          onRestart={() => setRestartKey((k) => k + 1)}
          launch={launch}
          adoptPtyId={adoptForThisMount}
        />
      </div>
    </section>
  );
}

type SessionStatus = 'starting' | 'running' | 'no-project' | 'not-consented' | 'exited';

interface TerminalSessionProps {
  readonly bridge: OkDesktopBridge;
  readonly onClose?: () => void;
  readonly onExit?: (info: { readonly exitCode: number; readonly signal: number | null }) => void;
  readonly onTitleChange?: (title: string) => void;
  readonly onRestart: () => void;
  readonly launch?: TerminalLaunchIntent | null;
  /** Surviving PTY to adopt on mount instead of spawning a fresh shell; `null`
   *  spawns fresh (the normal path). */
  readonly adoptPtyId?: string | null;
}

function TerminalSession({
  bridge,
  onClose,
  onExit,
  onTitleChange,
  onRestart,
  launch = null,
  adoptPtyId = null,
}: TerminalSessionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const { resolvedTheme } = useTheme();
  const termRef = useRef<Terminal | null>(null);
  const initialResolvedThemeRef = useRef(resolvedTheme);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [readiness, setReadiness] = useState<ClaudeReadiness | null>(null);
  const [preflightDone, setPreflightDone] = useState(false);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [firstOutputSeen, setFirstOutputSeen] = useState(false);
  const lastLaunchedNonceRef = useRef<number | null>(null);
  const [missingCli, setMissingCli] = useState<TerminalCli | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let ptyId: string | null = null;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let titleDisposable: { dispose(): void } | undefined;
    let observer: ResizeObserver | undefined;

    const term = new Terminal({
      screenReaderMode: true,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 13,
      scrollback: 10000,
      smoothScrollDuration: 125,
      scrollSensitivity: 3,
      theme: xtermThemeForMode(initialResolvedThemeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon());

    term.open(container);

    const useDomRenderer = bridge.config.e2eSmoke === true;
    if (!useDomRenderer) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          console.warn('[terminal] WebGL context lost, falling back to DOM renderer');
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch (err) {
        const expected = err instanceof Error && /webgl2?|context/i.test(err.message);
        const log = expected ? console.warn : console.error;
        log('[terminal] WebGL addon failed, using DOM renderer:', err);
      }
    }

    fit.fit();

    titleDisposable = term.onTitleChange((title) => {
      if (!cancelled) onTitleChangeRef.current?.(title);
    });

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.shiftKey) return true;
      if (event.key === 'Tab') {
        event.preventDefault();
        return true;
      }
      if (event.key === 'Enter') {
        const ptyId = ptyIdRef.current;
        if (ptyId === null) return true;
        event.preventDefault();
        bridge.terminal.input(ptyId, '\n');
        return false;
      }
      return true;
    });

    let wheelRowAccumulator = 0;
    let warnedMissingCellHeight = false;
    term.attachCustomWheelEventHandler((event) => {
      const core = (
        term as unknown as {
          _core?: {
            coreMouseService?: { activeEncoding?: string };
            _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } };
          };
        }
      )._core;
      const encoding = core?.coreMouseService?.activeEncoding;
      const sgrTrackingActive =
        term.modes.mouseTrackingMode !== 'none' &&
        (encoding === 'SGR' || encoding === 'SGR_PIXELS');
      if (!sgrTrackingActive) {
        wheelRowAccumulator = 0; // reset between gestures/apps; defer to xterm
        return true;
      }
      const ptyId = ptyIdRef.current;
      if (ptyId === null || event.deltaY === 0) return true;
      const measuredCellHeight = core?._renderService?.dimensions?.css?.cell?.height;
      if (measuredCellHeight === undefined && !warnedMissingCellHeight) {
        warnedMissingCellHeight = true;
        console.warn(
          '[terminal] xterm cell-height internal not found; wheel scroll using fallback. An xterm upgrade may have moved _core._renderService.dimensions.css.cell.height.',
        );
      }
      const cellHeight = measuredCellHeight ?? 17;
      const { count, button, accumulator } = nextWheelReports(
        event.deltaY,
        event.deltaMode,
        wheelRowAccumulator,
        { cellHeight, sensitivity: 1.5, maxRowsPerEvent: 20, viewportRows: term.rows },
      );
      wheelRowAccumulator = accumulator;
      if (count > 0) bridge.terminal.input(ptyId, sgrWheelReport(button).repeat(count));
      return false;
    });

    const attachSession = (livePtyId: string) => {
      ptyId = livePtyId;
      ptyIdRef.current = livePtyId;
      setStatus('running');

      term.onData((data) => {
        if (ptyId) bridge.terminal.input(ptyId, data);
      });

      unsubData = bridge.terminal.onData((msg) => {
        if (msg.ptyId !== ptyId) return;
        if (!cancelled) setFirstOutputSeen(true);
        term.write(msg.data, () => bridge.terminal.drain(msg.ptyId, msg.data.length));
      });

      unsubExit = bridge.terminal.onExit((msg) => {
        if (msg.ptyId !== ptyId) return;
        setExitInfo({ exitCode: msg.exitCode, signal: msg.signal, error: msg.error });
        setStatus('exited');
        onExitRef.current?.({ exitCode: msg.exitCode, signal: msg.signal });
      });

      observer = new ResizeObserver(() => {
        fit.fit();
        if (ptyId) bridge.terminal.resize(ptyId, term.cols, term.rows);
      });
      observer.observe(container);

      term.focus();

      bridge.terminal
        .claudePreflight()
        .then((readinessResult) => {
          if (!cancelled) setReadiness(readinessResult);
        })
        .catch((err) => {
          console.warn('[terminal] claude readiness preflight failed', err);
        })
        .finally(() => {
          if (!cancelled) setPreflightDone(true);
        });
    };

    void (async () => {
      if (adoptPtyId !== null) {
        let adopted: Awaited<ReturnType<typeof bridge.terminal.adopt>>;
        try {
          adopted = await bridge.terminal.adopt(adoptPtyId);
        } catch (err) {
          console.error('[terminal] adopt() failed:', err);
          adopted = { ok: false, reason: 'unknown-session' };
        }
        if (cancelled) return;
        if (adopted.ok) {
          if (adopted.replay) term.write(adopted.replay);
          attachSession(adoptPtyId);
          bridge.terminal.resize(adoptPtyId, term.cols, term.rows);
          return;
        }
      }

      let result: Awaited<ReturnType<typeof bridge.terminal.create>>;
      try {
        result = await bridge.terminal.create({ cols: term.cols, rows: term.rows });
      } catch (err) {
        console.error('[terminal] create() failed:', err);
        if (cancelled) return;
        setExitInfo({
          exitCode: 1,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
        });
        setStatus('exited');
        return;
      }

      if (cancelled) {
        if (result.ok)
          void bridge.terminal
            .kill(result.ptyId)
            .catch((err) => console.warn('[terminal] kill after cancelled mount failed:', err));
        return;
      }
      if (!result.ok) {
        setStatus(result.reason === 'not-consented' ? 'not-consented' : 'no-project');
        return;
      }

      attachSession(result.ptyId);
    })();

    return () => {
      cancelled = true;
      ptyIdRef.current = null;
      termRef.current = null;
      observer?.disconnect();
      unsubData?.();
      unsubExit?.();
      titleDisposable?.dispose();
      term.dispose();
      if (ptyId)
        void bridge.terminal
          .kill(ptyId)
          .catch((err) => console.warn('[terminal] kill on unmount failed:', err));
    };
  }, [bridge, adoptPtyId]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = xtermThemeForMode(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (launch === null) return;
    if (adoptPtyId !== null) return;
    if (status !== 'running') return;
    if (!firstOutputSeen) return;
    if (lastLaunchedNonceRef.current === launch.nonce) return;
    const ptyId = ptyIdRef.current;
    if (ptyId === null) return;

    const nonce = launch.nonce;
    let cancelled = false;

    if (launch.cli === 'claude') {
      if (!preflightDone) return;
      setMissingCli(null);
      if (readiness?.claude === 'not-found') {
        lastLaunchedNonceRef.current = nonce; // banner handles remediation; consume
        return;
      }
      const { prompt } = launch;
      const writeClaude = (mcpPreApprove: boolean) => {
        if (cancelled) return;
        const livePtyId = ptyIdRef.current;
        if (livePtyId === null) return;
        bridge.terminal.input(
          livePtyId,
          buildCliLaunchCommand('claude', prompt, { mcpPreApprove }),
        );
        lastLaunchedNonceRef.current = nonce; // commit only after the write lands
      };
      void bridge.terminal
        .claudePreflight()
        .then((fresh) => {
          if (cancelled) return;
          if (fresh.claude === 'present') {
            writeClaude(fresh.mcpPreApprovable === true);
            return;
          }
          setReadiness(
            fresh.claude === 'not-found'
              ? fresh
              : { claude: 'not-found', mcp: fresh.mcp, mcpPreApprovable: false },
          );
          lastLaunchedNonceRef.current = nonce;
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn('[terminal] claude pre-approval recheck failed', { nonce, err });
          setReadiness({ claude: 'not-found', mcp: 'needs-rewire', mcpPreApprovable: false });
          lastLaunchedNonceRef.current = nonce;
        });
      return () => {
        cancelled = true;
      };
    }

    setMissingCli(null);
    const { cli, prompt } = launch;
    const writeLaunch = () => {
      if (cancelled) return;
      const livePtyId = ptyIdRef.current;
      if (livePtyId === null) return;
      bridge.terminal.input(livePtyId, buildCliLaunchCommand(cli, prompt));
      lastLaunchedNonceRef.current = nonce; // commit only after the write lands
    };
    const suppress = () => {
      if (cancelled) return;
      setMissingCli(cli);
      lastLaunchedNonceRef.current = nonce; // banner handles remediation; consume
    };
    void (async () => {
      try {
        let res = await bridge.terminal.cliPreflight(cli);
        if (res.onPath === 'unknown') {
          if (cancelled) return;
          res = await bridge.terminal.cliPreflight(cli);
        }
        if (cancelled) return;
        if (res.onPath === 'present') writeLaunch();
        else suppress();
      } catch (err) {
        if (cancelled) return;
        console.warn('[terminal] cliPreflight failed', { cli, err });
        suppress();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, launch, status, firstOutputSeen, preflightDone, readiness, adoptPtyId]);

  return (
    <div className="flex h-full w-full flex-col">
      {status === 'running' && readiness ? (
        <ClaudeReadinessBanner
          readiness={readiness}
          bridge={bridge}
          onDismiss={() => setReadiness(null)}
        />
      ) : null}
      {status === 'running' && missingCli ? (
        <TerminalCliMissingBanner
          cli={missingCli}
          bridge={bridge}
          onDismiss={() => setMissingCli(null)}
        />
      ) : null}
      <div ref={containerRef} data-terminal-status={status} className="min-h-0 flex-1 px-1.5" />
      {status === 'exited' && exitInfo ? (
        <TerminalExitNotice info={exitInfo} onRestart={onRestart} />
      ) : null}
      {status === 'no-project' || status === 'not-consented' ? (
        <TerminalRefusalNotice reason={status} onClose={onClose} />
      ) : null}
    </div>
  );
}
