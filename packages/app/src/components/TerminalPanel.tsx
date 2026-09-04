import '@xterm/xterm/css/xterm.css';

import {
  buildCliLaunchArgString,
  buildStartupInjectionBytes,
  buildWindowsCliLaunch,
  quoteWindowsShellPath,
  shellSingleQuote,
  startupInjectionFor,
  type TerminalCli,
  type TerminalLaunchCommand,
  type WindowsShellFamily,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useTheme } from 'next-themes';
import { use, useEffect, useRef, useState } from 'react';
import { ConfigContext } from '@/lib/config-context';
import type { ClaudeReadiness, OkDesktopBridge, OkPtyNotice } from '@/lib/desktop-bridge-types';
import { cn } from '@/lib/utils';
import { getPageListCache } from '../editor/page-list-cache';
import { filePathToDocName, hashFromDocName, hashFromFolderPath } from '../lib/doc-hash';
import { ClaudeReadinessBanner } from './ClaudeReadinessBanner';
import type { TerminalLaunchIntent } from './EditorPane';
import { filesFromExternalDrop, isExternalFileDrag } from './file-tree-adapter';
import {
  type TerminalCommandId,
  terminalCommandFor,
  windowsTerminalCommandFor,
} from './handoff/terminal-command-events';
import { TerminalCliMissingBanner } from './TerminalCliMissingBanner';
import { TerminalCliUnverifiedBanner } from './TerminalCliUnverifiedBanner';
import { type TerminalExitInfo, TerminalExitNotice } from './TerminalExitNotice';
import { TerminalNoticeBanner } from './TerminalNoticeBanner';
import { TerminalRefusalNotice } from './TerminalRefusalNotice';
import { TerminalStartingNotice } from './TerminalStartingNotice';
import { isRenderedContainer, shouldFitForResize } from './terminal-fit-gate';
import { createTerminalFileLinkProvider } from './terminal-link-provider';
import { createRecentOpenGuard, type TerminalLinkTarget } from './terminal-links';
import { createSameFrameRepaint } from './terminal-render-flush';
import { createResizeThrottle } from './terminal-resize-throttle';
import { restoreScrollReach } from './terminal-scroll-reach';
import { nextWheelReports, sgrWheelReport, wheelReportPosition } from './terminal-wheel';
import { useLiveXtermTheme } from './use-live-xterm-theme';

const PTY_RESIZE_THROTTLE_MS = 100;

export const STAGE_PASTE_SETTLE_MS = 500;

interface TerminalPanelProps {
  readonly bridge: OkDesktopBridge;
  readonly className?: string;
  readonly onClose?: () => void;
  readonly onExit?: (info: { readonly exitCode: number; readonly signal: number | null }) => void;
  readonly onTitleChange?: (title: string) => void;
  readonly launch?: TerminalLaunchIntent | null;
  readonly commandId?: TerminalCommandId | null;
  readonly adoptPtyId?: string | null;
  readonly onPtyId?: (ptyId: string | null) => void;
}

export function TerminalPanel({
  bridge,
  className,
  onClose,
  onExit,
  onTitleChange,
  launch = null,
  commandId = null,
  adoptPtyId = null,
  onPtyId,
}: TerminalPanelProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const xtermTheme = useLiveXtermTheme(resolvedTheme);
  const [restartKey, setRestartKey] = useState(0);
  const adoptForThisMount = restartKey === 0 ? adoptPtyId : null;
  return (
    <section
      aria-label={t`Terminal`}
      style={{ backgroundColor: xtermTheme.background }}
      className={cn('relative flex h-full w-full flex-col overflow-hidden', className)}
    >
      {}
      <div className="relative min-h-0 flex-1">
        <TerminalSession
          key={restartKey}
          bridge={bridge}
          onClose={onClose}
          onExit={onExit}
          onTitleChange={onTitleChange}
          onRestart={() => setRestartKey((k) => k + 1)}
          launch={launch}
          commandId={commandId}
          adoptPtyId={adoptForThisMount}
          onPtyId={onPtyId}
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
  readonly commandId?: TerminalCommandId | null;
  readonly adoptPtyId?: string | null;
  readonly onPtyId?: (ptyId: string | null) => void;
}

function TerminalSession({
  bridge,
  onClose,
  onExit,
  onTitleChange,
  onRestart,
  launch = null,
  commandId = null,
  adoptPtyId = null,
  onPtyId,
}: TerminalSessionProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const onPtyIdRef = useRef(onPtyId);
  const { resolvedTheme } = useTheme();
  const xtermTheme = useLiveXtermTheme(resolvedTheme);
  const termRef = useRef<Terminal | null>(null);
  const initialXtermThemeRef = useRef(xtermTheme);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [hasOutput, setHasOutput] = useState(false);
  const [readiness, setReadiness] = useState<ClaudeReadiness | null>(null);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);
  const [shellNotice, setShellNotice] = useState<Extract<
    OkPtyNotice,
    { notice: 'invalid-shell-override' }
  > | null>(null);
  const [supportFileNotice, setSupportFileNotice] = useState<Extract<
    OkPtyNotice,
    { notice: 'support-file-degraded' }
  > | null>(null);
  const [pathDropNotice, setPathDropNotice] = useState(false);
  const [manualSubmitNotice, setManualSubmitNotice] = useState(false);
  const ptyIdRef = useRef<string | null>(null);
  const terminalInputEnabledRef = useRef(false);
  const terminalInputRef = useRef<(data: string) => void>(() => undefined);
  const [cliNotice, setCliNotice] = useState<
    | { cli: TerminalCli; kind: 'unverified' }
    | { cli: Exclude<TerminalCli, 'claude'>; kind: 'not-found' }
    | null
  >(null);

  const configCtx = use(ConfigContext);
  const autoApproveOkToolsRef = useRef(configCtx?.userConfig?.agents?.autoApproveOkTools ?? true);
  const shellFamilyRef = useRef<WindowsShellFamily | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
    onPtyIdRef.current = onPtyId;
    autoApproveOkToolsRef.current = configCtx?.userConfig?.agents?.autoApproveOkTools ?? true;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setManualSubmitNotice(false);
    setSupportFileNotice(null);
    setShellNotice(null);
    setPathDropNotice(false);
    terminalInputEnabledRef.current = false;

    let cancelled = false;
    let sessionEnded = false;
    let ptyId: string | null = null;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubNotice: (() => void) | undefined;
    let pendingShellNotices: OkPtyNotice[] = [];
    let launchCapabilityLimited = false;
    let readinessScan: ((data: string) => void) | undefined;
    let injectCapTimer: ReturnType<typeof setTimeout> | undefined;
    let titleDisposable: { dispose(): void } | undefined;
    let linkProviderDisposable: { dispose(): void } | undefined;
    let observer: ResizeObserver | undefined;
    let canvasPixelObserver: ResizeObserver | undefined;
    let ptyResizeThrottle: ReturnType<typeof createResizeThrottle> | undefined;
    let documentUnloading = false;
    const markDocumentUnloading = (event: PageTransitionEvent): void => {
      documentUnloading = !event.persisted;
    };
    const markDocumentVisible = (): void => {
      if (document.visibilityState === 'visible') documentUnloading = false;
    };
    window.addEventListener('pagehide', markDocumentUnloading);
    document.addEventListener('visibilitychange', markDocumentVisible);

    const applyShellNotice = (notice: OkPtyNotice): void => {
      if (notice.notice === 'shell-resolved') {
        shellFamilyRef.current = notice.shellFamily;
      } else if (notice.notice === 'invalid-shell-override') {
        if (notice.reason === 'unsupported-family') launchCapabilityLimited = true;
        setShellNotice(notice);
      } else {
        setSupportFileNotice(notice);
      }
    };

    unsubNotice = bridge.terminal.onNotice((msg) => {
      if (ptyId === null) {
        pendingShellNotices.push(msg);
        return;
      }
      if (msg.ptyId !== ptyId) return;
      applyShellNotice(msg);
    });

    const screenReaderModeAtMount =
      bridge.config.e2eSmoke === true || (bridge.accessibility?.isScreenReaderActive() ?? true);
    const recentOpen = createRecentOpenGuard();
    const openUrl = (uri: string) => {
      if (termRef.current?.modes.mouseTrackingMode !== 'none') return;
      if (recentOpen(uri, Date.now())) return;
      void bridge.shell.openExternal(uri);
    };
    const term = new Terminal({
      screenReaderMode: screenReaderModeAtMount,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 13,
      scrollback: 10000,
      smoothScrollDuration: 125,
      scrollSensitivity: 3,
      linkHandler: {
        activate: (_event, uri) => openUrl(uri),
      },
      theme: initialXtermThemeRef.current,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri)));

    term.open(container);

    const activateFileLink = (target: TerminalLinkTarget) => {
      switch (target.kind) {
        case 'doc':
          window.location.hash = hashFromDocName(filePathToDocName(target.relPath));
          return;
        case 'folder':
          window.location.hash = hashFromFolderPath(target.relPath);
          return;
        case 'external':
          void bridge.shell
            .revealExternal(target.absPath)
            .catch((err) => console.warn('[terminal] revealExternal failed:', err));
          return;
        case 'asset':
          void bridge.shell
            .openAsset(target.relPath)
            .then((result) => {
              if (result.ok) return;
              if (result.reason === 'extension-blocked') {
                void bridge.shell
                  .revealAsset(target.relPath)
                  .catch((err) => console.warn('[terminal] revealAsset failed:', err));
                return;
              }
              console.warn('[terminal] openAsset refused:', result.reason);
            })
            .catch((err) => console.warn('[terminal] openAsset failed:', err));
          return;
        default: {
          const _never: never = target;
          return _never;
        }
      }
    };
    linkProviderDisposable = term.registerLinkProvider(
      createTerminalFileLinkProvider({
        projectPath: bridge.config.projectPath,
        readLogicalLine: (bufferLineNumber) => {
          const buf = term.buffer.active;
          const idx = bufferLineNumber - 1;
          if (!buf.getLine(idx)) return undefined;
          let start = idx;
          while (start > 0 && buf.getLine(start)?.isWrapped) start--;
          let end = idx;
          while (buf.getLine(end + 1)?.isWrapped) end++;
          let text = '';
          for (let row = start; row <= end; row++) {
            text += buf.getLine(row)?.translateToString(false) ?? '';
          }
          return { text, startLine: start + 1, cols: term.cols };
        },
        getSnapshot: getPageListCache,
        checkTargetExists: (kind, path) =>
          bridge.project.checkTargetExists({
            projectPath: bridge.config.projectPath,
            kind,
            path,
          }),
        onActivate: activateFileLink,
      }),
    );

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

    if (
      isRenderedContainer(container.getBoundingClientRect(), window.getComputedStyle(container))
    ) {
      fit.fit();
    }

    const repaintSameFrame = createSameFrameRepaint(term);

    const webglCanvas = container.querySelector<HTMLCanvasElement>('.xterm-screen canvas');
    if (webglCanvas !== null) {
      canvasPixelObserver = new ResizeObserver(() => repaintSameFrame());
      try {
        canvasPixelObserver.observe(webglCanvas, { box: 'device-pixel-content-box' });
      } catch (err) {
        console.warn('[terminal] device-pixel canvas observe failed:', err);
        canvasPixelObserver.disconnect();
        canvasPixelObserver = undefined;
      }
    }

    titleDisposable = term.onTitleChange((title) => {
      if (!cancelled) onTitleChangeRef.current?.(title);
    });

    const sendInput = (data: string): void => {
      const livePtyId = ptyIdRef.current;
      if (cancelled || !terminalInputEnabledRef.current || livePtyId === null) return;
      bridge.terminal.input(livePtyId, data);
    };
    terminalInputRef.current = sendInput;
    const markInteractive = (): void => {
      if (cancelled || sessionEnded || terminalInputEnabledRef.current) return;
      terminalInputEnabledRef.current = true;
      setStatus('running');
      term.focus();
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const key = event.key.toLowerCase();
      const platformClipboardKey =
        (bridge.platform === 'linux' || bridge.platform === 'win32') &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        (key === 'c' || key === 'v');
      if (platformClipboardKey) {
        event.preventDefault();

        if (key === 'c') {
          const hasSelection = term.hasSelection();
          const copiesSelection = event.shiftKey || (bridge.platform === 'win32' && hasSelection);
          if (!copiesSelection) return true;
          if (hasSelection && navigator.clipboard?.writeText) {
            void navigator.clipboard
              .writeText(term.getSelection())
              .catch((err) => console.warn('[terminal] clipboard copy failed', err));
          }
          if (bridge.platform === 'win32') term.clearSelection();
          return false;
        }

        if (!event.shiftKey && bridge.platform !== 'win32') return true;
        if (!terminalInputEnabledRef.current) return false;
        if (navigator.clipboard?.readText) {
          void navigator.clipboard
            .readText()
            .then((text) => {
              const ptyId = ptyIdRef.current;
              if (!cancelled && ptyId !== null) term.paste(text);
            })
            .catch((err) => console.warn('[terminal] clipboard paste failed', err));
        }
        return false;
      }

      if (!event.shiftKey) return true;
      if (event.key === 'Tab') {
        event.preventDefault();
        return true;
      }
      if (event.key === 'Enter') {
        const ptyId = ptyIdRef.current;
        if (ptyId === null) return true;
        event.preventDefault();
        sendInput('\n');
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
            _renderService?: {
              dimensions?: { css?: { cell?: { width?: number; height?: number } } };
            };
          };
        }
      )._core;
      const encoding = core?.coreMouseService?.activeEncoding;
      const sgrTrackingActive =
        term.modes.mouseTrackingMode !== 'none' &&
        (encoding === 'SGR' || encoding === 'SGR_PIXELS');
      if (!sgrTrackingActive) {
        wheelRowAccumulator = 0;
        return true;
      }
      if (!terminalInputEnabledRef.current || event.deltaY === 0) return true;
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
      if (count > 0) {
        const rect = (
          term.element?.querySelector('.xterm-screen') ?? term.element
        )?.getBoundingClientRect();
        const position = wheelReportPosition(
          rect === undefined ? undefined : event.clientX - rect.left,
          rect === undefined ? undefined : event.clientY - rect.top,
          {
            cellWidth: core?._renderService?.dimensions?.css?.cell?.width,
            cellHeight,
            cols: term.cols,
            rows: term.rows,
            pixels: encoding === 'SGR_PIXELS',
          },
        );
        sendInput(sgrWheelReport(button, position).repeat(count));
      }
      return false;
    });

    let sawFirstOutput = false;
    const markFirstOutput = () => {
      if (sawFirstOutput) return;
      sawFirstOutput = true;
      setHasOutput(true);
    };

    const attachSession = (livePtyId: string): void => {
      ptyId = livePtyId;
      ptyIdRef.current = livePtyId;
      onPtyIdRef.current?.(livePtyId);
      for (const notice of pendingShellNotices) {
        if (notice.ptyId !== livePtyId) continue;
        applyShellNotice(notice);
      }
      pendingShellNotices = [];

      term.onData((data) => {
        sendInput(data);
      });

      unsubData = bridge.terminal.onData((msg) => {
        if (msg.ptyId !== ptyId) return;
        markFirstOutput();
        term.write(msg.data, () => bridge.terminal.drain(msg.ptyId, msg.data.length));
        readinessScan?.(msg.data);
      });

      unsubExit = bridge.terminal.onExit((msg) => {
        if (msg.ptyId !== ptyId) return;
        sessionEnded = true;
        terminalInputEnabledRef.current = false;
        setExitInfo({ exitCode: msg.exitCode, signal: msg.signal, error: msg.error });
        setStatus('exited');
        onExitRef.current?.({ exitCode: msg.exitCode, signal: msg.signal });
      });

      ptyResizeThrottle = createResizeThrottle(() => {
        if (ptyId) bridge.terminal.resize(ptyId, term.cols, term.rows);
      }, PTY_RESIZE_THROTTLE_MS);
      observer = new ResizeObserver((entries) => {
        if (!shouldFitForResize(entries)) return;
        const colsBefore = term.cols;
        const rowsBefore = term.rows;
        fit.fit();
        if (term.cols !== colsBefore || term.rows !== rowsBefore) {
          repaintSameFrame();
          restoreScrollReach(term);
        }
        ptyResizeThrottle?.request();
      });
      observer.observe(container);
    };

    const resolveLaunchCommand = async (
      intent: TerminalLaunchIntent,
    ): Promise<string | TerminalLaunchCommand | undefined> => {
      const buildLaunch = (opts: Parameters<typeof buildCliLaunchArgString>[2]) =>
        bridge.platform === 'win32'
          ? buildWindowsCliLaunch(intent.cli, intent.prompt, opts)
          : buildCliLaunchArgString(intent.cli, intent.prompt, opts);
      if (intent.cli === 'claude') {
        try {
          const fresh = await bridge.terminal.claudePreflight();
          if (fresh.claude === 'present') {
            if (!cancelled) setReadiness(fresh);
            return buildLaunch({
              mcpPreApprove: fresh.mcpPreApprovable === true,
              autoApproveOkTools: autoApproveOkToolsRef.current && fresh.mcpPreApprovable === true,
            });
          }
          if (!cancelled) {
            if (fresh.claude === 'not-found') {
              setReadiness(fresh);
            } else {
              setCliNotice({ cli: 'claude', kind: 'unverified' });
            }
          }
        } catch (err) {
          console.warn('[terminal] claude launch preflight failed', err);
          if (!cancelled) setCliNotice({ cli: 'claude', kind: 'unverified' });
        }
        return undefined;
      }
      try {
        let res = await bridge.terminal.cliPreflight(intent.cli);
        if (res.onPath === 'unknown') {
          if (cancelled) return undefined;
          res = await bridge.terminal.cliPreflight(intent.cli);
        }
        if (res.onPath === 'present') {
          return buildLaunch({
            autoApproveOkTools:
              intent.cli === 'codex' &&
              res.okServerConfigured === true &&
              autoApproveOkToolsRef.current,
          });
        }
        if (!cancelled) {
          setCliNotice({
            cli: intent.cli,
            kind: res.onPath === 'not-found' ? 'not-found' : 'unverified',
          });
        }
      } catch (err) {
        console.warn('[terminal] cliPreflight failed', { cli: intent.cli, err });
        if (!cancelled) setCliNotice({ cli: intent.cli, kind: 'unverified' });
      }
      return undefined;
    };

    let stagePasteTimer: ReturnType<typeof setTimeout> | undefined;

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
          shellFamilyRef.current = adopted.shellFamily ?? null;
          if (adopted.shellNoticeReason !== undefined) {
            applyShellNotice({
              ptyId: adoptPtyId,
              notice: 'invalid-shell-override',
              reason: adopted.shellNoticeReason,
            });
          }
          const replay = adopted.replay;
          const hasReplay = replay !== '';
          attachSession(adoptPtyId);
          if (hasReplay) {
            markFirstOutput();
            term.write(replay, markInteractive);
          } else {
            markInteractive();
          }
          return;
        }
      }

      let launchCommand: string | TerminalLaunchCommand | undefined;
      if (launch !== null && adoptPtyId === null) {
        launchCommand = await resolveLaunchCommand(launch);
        if (cancelled) return;
      } else if (commandId !== null && adoptPtyId === null) {
        launchCommand =
          bridge.platform === 'win32'
            ? windowsTerminalCommandFor(commandId)
            : terminalCommandFor(commandId);
      }

      let result: Awaited<ReturnType<typeof bridge.terminal.create>>;
      try {
        result = await bridge.terminal.create({ cols: term.cols, rows: term.rows, launchCommand });
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
      markInteractive();

      const staged = launch?.stagePaste;
      const injectionBytes =
        launch != null && launchCommand !== undefined && launch.prompt != null
          ? buildStartupInjectionBytes(launch.cli, launch.prompt, bridge.platform)
          : null;
      if (injectionBytes != null && launch != null) {
        const cfg = startupInjectionFor(launch.cli, bridge.platform);
        const settleMs = cfg?.settleMs ?? STAGE_PASTE_SETTLE_MS;
        const marker = cfg?.readyMarker;
        const bytes = injectionBytes;
        const stagedBytes =
          bridge.platform === 'win32' && cfg != null && bytes.endsWith(cfg.submit)
            ? bytes.slice(0, -cfg.submit.length)
            : bytes;
        let fired = false;
        const inject = (): void => {
          if (fired) return;
          fired = true;
          readinessScan = undefined;
          if (stagePasteTimer !== undefined) clearTimeout(stagePasteTimer);
          if (injectCapTimer !== undefined) clearTimeout(injectCapTimer);
          if (cancelled || !terminalInputEnabledRef.current || launchCapabilityLimited) return;
          const isWindowsStagedPaste = bridge.platform === 'win32';
          const payload = isWindowsStagedPaste ? stagedBytes : bytes;
          sendInput(payload);
          term.focus();
          if (isWindowsStagedPaste) setManualSubmitNotice(true);
        };
        injectCapTimer = setTimeout(inject, cfg?.capMs ?? settleMs);
        if (marker != null) {
          let acc = '';
          readinessScan = (data) => {
            if (fired || stagePasteTimer !== undefined) return;
            acc += data;
            if (acc.includes(marker)) {
              readinessScan = undefined;
              stagePasteTimer = setTimeout(inject, settleMs);
              return;
            }
            if (acc.length > marker.length + 256) acc = acc.slice(-(marker.length + 256));
          };
        } else {
          stagePasteTimer = setTimeout(inject, settleMs);
        }
      } else if (launch != null && launch.prompt != null && staged != null) {
        console.warn(
          '[terminal] TerminalLaunchIntent carried both prompt and stagePaste; dropping stagePaste',
        );
      } else if (launchCommand !== undefined && staged != null && staged !== '') {
        stagePasteTimer = setTimeout(() => {
          if (cancelled || !terminalInputEnabledRef.current || launchCapabilityLimited) return;
          sendInput(staged);
          term.focus();
        }, STAGE_PASTE_SETTLE_MS);
      }
    })();

    return () => {
      cancelled = true;
      terminalInputEnabledRef.current = false;
      terminalInputRef.current = () => undefined;
      window.removeEventListener('pagehide', markDocumentUnloading);
      document.removeEventListener('visibilitychange', markDocumentVisible);
      if (stagePasteTimer !== undefined) clearTimeout(stagePasteTimer);
      if (injectCapTimer !== undefined) clearTimeout(injectCapTimer);
      readinessScan = undefined;
      ptyIdRef.current = null;
      onPtyIdRef.current?.(null);
      termRef.current = null;
      observer?.disconnect();
      canvasPixelObserver?.disconnect();
      ptyResizeThrottle?.cancel();
      unsubData?.();
      unsubExit?.();
      unsubNotice?.();
      titleDisposable?.dispose();
      linkProviderDisposable?.dispose();
      term.dispose();
      if (ptyId && !documentUnloading)
        void bridge.terminal
          .kill(ptyId)
          .catch((err) => console.warn('[terminal] kill on unmount failed:', err));
    };
  }, [bridge, adoptPtyId, launch, commandId]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = xtermTheme;
  }, [xtermTheme]);

  useEffect(() => {
    const accessibility = bridge.accessibility;
    if (accessibility == null || bridge.config.e2eSmoke === true) return;
    return accessibility.onScreenReaderChanged((active) => {
      const term = termRef.current;
      if (term !== null) term.options.screenReaderMode = active;
    });
  }, [bridge]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    function onDragOver(event: DragEvent) {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
    }
    function onDrop(event: DragEvent) {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      if (!terminalInputEnabledRef.current) return;
      const droppedFiles = filesFromExternalDrop(event);
      const paths = droppedFiles
        .map((file) => bridge.getPathForFile(file))
        .filter(
          (path): path is string =>
            path !== null && path !== '' && !Array.from(path).some((ch) => ch.charCodeAt(0) < 0x20),
        );
      let rejectedCount = droppedFiles.length - paths.length;
      const escapedPaths = paths.flatMap((path) => {
        if (bridge.platform !== 'win32') return [shellSingleQuote(path)];
        const family = shellFamilyRef.current;
        if (family === null) {
          rejectedCount += 1;
          return [];
        }
        const quoted = quoteWindowsShellPath(family, path);
        if (quoted === null) {
          rejectedCount += 1;
          return [];
        }
        return [quoted];
      });
      if (rejectedCount > 0) setPathDropNotice(true);
      if (escapedPaths.length === 0) return;
      terminalInputRef.current(`${escapedPaths.join(' ')} `);
    }
    container.addEventListener('dragover', onDragOver, { capture: true });
    container.addEventListener('drop', onDrop, { capture: true });
    return () => {
      container.removeEventListener('dragover', onDragOver, { capture: true });
      container.removeEventListener('drop', onDrop, { capture: true });
    };
  }, [bridge]);

  return (
    <div className="flex h-full w-full flex-col">
      {status === 'running' && readiness ? (
        <ClaudeReadinessBanner
          readiness={readiness}
          bridge={bridge}
          onDismiss={() => setReadiness(null)}
        />
      ) : null}
      {status === 'running' && cliNotice ? (
        cliNotice.kind === 'not-found' ? (
          <TerminalCliMissingBanner
            cli={cliNotice.cli}
            bridge={bridge}
            onDismiss={() => setCliNotice(null)}
          />
        ) : (
          <TerminalCliUnverifiedBanner cli={cliNotice.cli} onDismiss={() => setCliNotice(null)} />
        )
      ) : null}
      {status === 'running' ? (
        pathDropNotice ? (
          <TerminalNoticeBanner
            testId="terminal-path-drop-notice-banner"
            onDismiss={() => setPathDropNotice(false)}
          >
            {t`Some dropped files could not be inserted safely.`}
          </TerminalNoticeBanner>
        ) : supportFileNotice ? (
          <TerminalNoticeBanner
            testId="terminal-support-file-notice-banner"
            onDismiss={() => setSupportFileNotice(null)}
          >
            {supportFileNotice.reason === 'containment-refused'
              ? t`OpenKnowledge couldn't write launch settings under .ok/local/terminal because the folder is not safely contained in this project. Check that it is a real folder inside the project, not a link. Claude will ask you to approve OpenKnowledge.`
              : t`OpenKnowledge couldn't write launch settings under .ok/local/terminal this time. Check that the folder is writable. Claude will ask you to approve OpenKnowledge.`}
          </TerminalNoticeBanner>
        ) : shellNotice ? (
          <TerminalNoticeBanner
            testId="terminal-shell-notice-banner"
            onDismiss={() => setShellNotice(null)}
          >
            {shellNotice.reason === 'config-unreadable'
              ? t`OpenKnowledge couldn't read terminal.shell in .ok/local/config.yml. Using an available Windows shell instead.`
              : shellNotice.reason === 'invalid-value'
                ? t`terminal.shell in .ok/local/config.yml must be a string. Using an available Windows shell instead.`
                : shellNotice.reason === 'not-absolute'
                  ? t`terminal.shell in .ok/local/config.yml must be an absolute Windows path. Using an available Windows shell instead.`
                  : shellNotice.reason === 'unsupported-family'
                    ? t`terminal.shell in .ok/local/config.yml supports PowerShell, cmd.exe, or Git Bash for OpenKnowledge-managed launches and dropped-file paths. This shell opens a plain terminal only; agent and command launches do not run in it.`
                    : t`The terminal.shell executable in .ok/local/config.yml was not found. Using an available Windows shell instead.`}
          </TerminalNoticeBanner>
        ) : manualSubmitNotice ? (
          <TerminalNoticeBanner
            testId="terminal-manual-submit-notice-banner"
            onDismiss={() => setManualSubmitNotice(false)}
          >
            {t`The prompt was pasted but not submitted automatically. Review it, then press Enter to send it.`}
          </TerminalNoticeBanner>
        ) : null
      ) : null}
      {}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} data-terminal-status={status} className="h-full w-full px-1.5" />
        {status === 'starting' || (status === 'running' && !hasOutput) ? (
          <TerminalStartingNotice className="pointer-events-none absolute inset-0 z-20" />
        ) : null}
      </div>
      {status === 'exited' && exitInfo ? (
        <TerminalExitNotice info={exitInfo} onRestart={onRestart} />
      ) : null}
      {status === 'no-project' || status === 'not-consented' ? (
        <TerminalRefusalNotice reason={status} onClose={onClose} />
      ) : null}
    </div>
  );
}
