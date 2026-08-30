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
import { createTerminalFileLinkProvider } from './terminal-link-provider';
import { createRecentOpenGuard, type TerminalLinkTarget } from './terminal-links';
import { createSameFrameRepaint } from './terminal-render-flush';
import { createResizeThrottle } from './terminal-resize-throttle';
import { restoreScrollReach } from './terminal-scroll-reach';
import { nextWheelReports, sgrWheelReport, wheelReportPosition } from './terminal-wheel';
import { useLiveXtermTheme } from './use-live-xterm-theme';

/**
 * Interval for the PTY-resize throttle (see terminal-resize-throttle.ts).
 * Bounds the SIGWINCH → full-TUI-repaint → output-flood loop to ~10×/s during
 * a section drag; the trailing call lands the final size. The xterm fit itself
 * is NOT throttled — stepping it made the grid visibly jump ("flicker") during
 * drags, and it is cheap per event (FitAddon only reflows when a cell boundary
 * is actually crossed).
 */
const PTY_RESIZE_THROTTLE_MS = 100;

/** Settle beat between a staged-selection launch's PTY going live and the
 *  `stagePaste` write — long enough for the CLI TUI's stdin reader to attach (a
 *  write at raw PTY-live can race it). Exported so the dom tests derive their
 *  waited-past-the-window negative assertions from the same value instead of a
 *  hardcoded sibling that silently rots when this changes. */
export const STAGE_PASTE_SETTLE_MS = 500;

interface TerminalPanelProps {
  /** Desktop bridge — the panel is rendered only on the Electron host, where
   *  `window.okDesktop` is present. */
  readonly bridge: OkDesktopBridge;
  readonly className?: string;
  /**
   * Invoked by the explicit "Close terminal" button in a refusal/exit notice.
   * Closing collapses the dock and returns focus to the editor. When omitted
   * the button is not shown.
   *
   * Escape is intentionally NOT intercepted here — terminal apps (vim, the
   * `claude` TUI) rely on receiving Escape, so xterm delivers every key to the
   * PTY. The no-keyboard-trap exit (WCAG 2.1.2) is ⌘J/Ctrl+J, which collapses
   * the dock and returns focus to the editor.
   */
  readonly onClose?: () => void;
  /** Fires once when the shell exits or the PTY crashes. */
  readonly onExit?: (info: { readonly exitCode: number; readonly signal: number | null }) => void;
  /**
   * Fires whenever the running program sets the terminal title via an OSC 0/2
   * escape sequence (`ESC ] 0 ; <title> BEL` / `ESC ] 2 ; …`) — the same channel
   * shells, `vim`, and the `claude` TUI use to name the window. Lets the dock
   * label each tab with what its program reports. Empty titles are forwarded
   * verbatim; the consumer decides how to treat a cleared title.
   */
  readonly onTitleChange?: (title: string) => void;
  /**
   * "Open in terminal" launch intent. When set, the session bakes a
   * `<bin> '<prompt>'` invocation for the intent's `cli` into its PTY spawn
   * (`$SHELL -l -i -c '<cmd>; exec …'`) once the CLI is confirmed on PATH — so the
   * command never reaches the shell's line editor and is never recorded in shell
   * history. A missing CLI surfaces a banner instead. Each intent opens its own
   * tab, so the launch fires exactly once per session by construction.
   */
  readonly launch?: TerminalLaunchIntent | null;
  /**
   * "Run this in the terminal" one-shot (Settings → Slides). Bakes a fixed
   * command from a closed union into the spawn, with none of the CLI machinery.
   * See {@link TerminalSessionProps.commandId}.
   */
  readonly commandId?: TerminalCommandId | null;
  /**
   * A PTY that survived a renderer reload in the main process. When set, the
   * session adopts it (reconnects the live shell) on its first mount instead of
   * spawning a fresh one; `null` for a normally-opened tab. A restart always
   * spawns fresh, so adoption applies only to the initial mount.
   */
  readonly adoptPtyId?: string | null;
  /**
   * Reports this session's live PTY id up to the host: the resolved id once the
   * shell is live (freshly created OR adopted), and `null` when it tears down or
   * restarts. The host uses it to route an "Ask AI" launch into an already-open
   * terminal's live shell (write into the PTY) instead of spawning a new tab —
   * launches are baked into a fresh PTY spawn, so re-handing the intent to this
   * panel would respawn and kill the running session.
   */
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
  // Paint the panel chrome (the kill strip) with the exact xterm canvas color so
  // the strip and the terminal read as one surface — single source: terminal-theme.
  const { resolvedTheme } = useTheme();
  const xtermTheme = useLiveXtermTheme(resolvedTheme);
  // Restart is a full session reset: bumping the key remounts TerminalSession,
  // which disposes the dead terminal and spawns a fresh PTY in the same window
  // (cwd is fixed per window in main) — no stale listeners survive the swap.
  const [restartKey, setRestartKey] = useState(0);
  // Adoption is a one-time, first-mount concern: a user-driven restart (the
  // exit notice's "Restart") is an explicit ask for a fresh shell, so it must
  // never re-adopt the original — only the initial mount carries the survivor.
  const adoptForThisMount = restartKey === 0 ? adoptPtyId : null;
  return (
    // A named <section> is implicitly an ARIA `region` landmark — no explicit
    // role needed. It stays mounted across restarts; only the session inside it
    // is remounted.
    <section
      aria-label={t`Terminal`}
      style={{ backgroundColor: xtermTheme.background }}
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
  /** Forwarded title (OSC 0/2) reports — see {@link TerminalPanelProps.onTitleChange}. */
  readonly onTitleChange?: (title: string) => void;
  /** Spawn a fresh session (remount via the parent's key). */
  readonly onRestart: () => void;
  /** "Open in terminal" launch intent — baked into the PTY spawn when present
   *  (preflight-gated). See {@link TerminalPanelProps.launch}. */
  readonly launch?: TerminalLaunchIntent | null;
  /** "Run this in the terminal" one-shot from a UI surface (Settings → Slides).
   *  Mutually exclusive with {@link launch}: this bakes a fixed command from the
   *  closed {@link TerminalCommandId} union straight into the spawn, with none
   *  of the CLI machinery — no preflight, no readiness verdict, no missing-CLI
   *  banner, no startup injection — because there is no CLI involved. */
  readonly commandId?: TerminalCommandId | null;
  /** Surviving PTY to adopt on mount instead of spawning a fresh shell; `null`
   *  spawns fresh (the normal path). */
  readonly adoptPtyId?: string | null;
  /** Reports the live PTY id up (or `null` on teardown) — see
   *  {@link TerminalPanelProps.onPtyId}. */
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
  // Palette derived from the live theme tokens (mode + color theme + custom).
  const xtermTheme = useLiveXtermTheme(resolvedTheme);
  // Live xterm instance, exposed so the theme effect below can re-skin it in
  // place — re-theming must not tear down and respawn the PTY.
  const termRef = useRef<Terminal | null>(null);
  // Palette captured at first render, used for the initial xterm theme; later
  // theme changes flow through the dedicated effect below.
  const initialXtermThemeRef = useRef(xtermTheme);
  const [status, setStatus] = useState<SessionStatus>('starting');
  // Whether any shell byte has landed yet. `status` cannot answer this: on a
  // fresh create it flips to 'running' the instant a ptyId comes back, which is
  // BEFORE the utility process forks a PTY host and the login shell sources its
  // rc chain — the seconds a user actually waits. Without this the pane looks
  // identical whether a shell is coming or nothing happened at all.
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
  // Windows startup injection always stages the prompt WITHOUT its submit key,
  // so the user can review it before deciding to run it. Scoped to one launch
  // and dismissible.
  const [manualSubmitNotice, setManualSubmitNotice] = useState(false);
  // Live PTY id, mirrored out of the mount effect for the keyboard handlers.
  const ptyIdRef = useRef<string | null>(null);
  // These refs are shared with the external-drop effect below. Keeping the gate
  // and its single input chokepoint outside the session effect prevents that
  // listener from capturing stale session state across a replay or restart.
  const terminalInputEnabledRef = useRef(false);
  const terminalInputRef = useRef<(data: string) => void>(() => undefined);
  // Set when a launch suppressed its bake off a non-`present` verdict — drives
  // the per-CLI banner strip. `not-found` is the VERIFIED absence (the probe
  // ran and the binary is genuinely off the PATH); `unverified` covers a
  // still-unknown probe and a rejected preflight IPC, where the binary may
  // well be installed — the probe contract forbids presenting that as
  // "isn't installed". A genuine claude not-found routes through the richer
  // readiness banner instead (`setReadiness`), so `not-found` here is
  // non-claude only.
  const [cliNotice, setCliNotice] = useState<
    | { cli: TerminalCli; kind: 'unverified' }
    | { cli: Exclude<TerminalCli, 'claude'>; kind: 'not-found' }
    | null
  >(null);

  // Auto-approve OK's own tools for the baked launch (user-scope preference,
  // default on). Read the config context nullably (`use`, not `useConfigContext`)
  // so a TerminalPanel mounted without a ConfigProvider degrades to the default
  // rather than throwing. Held in a ref so a config change never re-runs the mount
  // effect (which would respawn the PTY) — the launch reads it once.
  const configCtx = use(ConfigContext);
  const autoApproveOkToolsRef = useRef(configCtx?.userConfig?.agents?.autoApproveOkTools ?? true);
  const shellFamilyRef = useRef<WindowsShellFamily | null>(null);

  // Keep the callbacks fresh without re-running the mount effect — a new
  // callback identity must NOT tear down and respawn the PTY.
  useEffect(() => {
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
    onPtyIdRef.current = onPtyId;
    autoApproveOkToolsRef.current = configCtx?.userConfig?.agents?.autoApproveOkTools ?? true;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // This effect run IS the session: a new launch re-runs it, so per-launch
    // notice state resets here rather than surviving into a session it does not
    // describe.
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
    // Startup-injection readiness: for a `startupInjection` CLI (Hermes), this
    // scans the PTY output for the CLI's ready marker so the prompt is pasted the
    // instant the input widget is live. Fed from attachSession's onData; armed by
    // the post-attach launch block. `injectCapTimer` is the marker-never-appears
    // fallback. Both are torn down on unmount alongside `stagePasteTimer`.
    let readinessScan: ((data: string) => void) | undefined;
    let injectCapTimer: ReturnType<typeof setTimeout> | undefined;
    let titleDisposable: { dispose(): void } | undefined;
    let linkProviderDisposable: { dispose(): void } | undefined;
    let observer: ResizeObserver | undefined;
    let canvasPixelObserver: ResizeObserver | undefined;
    let ptyResizeThrottle: ReturnType<typeof createResizeThrottle> | undefined;
    let documentUnloading = false;
    const markDocumentUnloading = (event: PageTransitionEvent): void => {
      // A bfcache hide preserves this renderer and must not suppress a later
      // explicit tab-close reap. A real navigation/reload tears the document
      // down after this event, while main keeps the window-scoped PTY available
      // for the next renderer to list and adopt.
      documentUnloading = !event.persisted;
    };
    const markDocumentVisible = (): void => {
      // Re-arms the ordinary tab-close reap for the case `pagehide` cannot
      // settle: a non-persisted hide on a document that then survives. A real
      // bfcache hide reports `persisted: true` above and never sets the flag.
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

    // Subscribe before create() so a fast utility response cannot outrun the
    // renderer's listener. Until this panel knows its ptyId, retain every notice
    // and address-check each one when attachSession wires the created shell.
    unsubNotice = bridge.terminal.onNotice((msg) => {
      if (ptyId === null) {
        pendingShellNotices.push(msg);
        return;
      }
      if (msg.ptyId !== ptyId) return;
      applyShellNotice(msg);
    });

    // xterm's screen-reader mode mirrors the viewport into a live a11y DOM on
    // every write and scroll — "a significant performance drop" per xterm's own
    // docs, and the largest single cost on the typing/scrolling path. Gate it
    // on the OS assistive-tech signal (the VS Code model): screen-reader users
    // get the full a11y tree, everyone else gets native-feeling latency. An
    // absent bridge surface fails accessible (mode on). The smoke suite pins it
    // on — its assertions read the .xterm-accessibility tree.
    const screenReaderModeAtMount =
      bridge.config.e2eSmoke === true || (bridge.accessibility?.isScreenReaderActive() ?? true);
    const recentOpen = createRecentOpenGuard();
    const openUrl = (uri: string) => {
      // Defer while a full-screen TUI owns the mouse: the click is delivered to
      // the app as a mouse report, so the terminal must not also open the link.
      // The `claude` TUI additionally opens URLs itself, which is the concrete
      // double-open this prevents. (Tradeoff: a URL printed inside a mouse-mode
      // TUI that does NOT open links itself — e.g. `less -R` — isn't
      // terminal-clickable; that matches how terminals gate clicks on mouse
      // apps.) `undefined` (pre-mount) also defers — fail closed.
      if (termRef.current?.modes.mouseTrackingMode !== 'none') return;
      // Collapse the OSC 8 `linkHandler` + `WebLinksAddon` pair for the same URL
      // (see createRecentOpenGuard).
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
      // Each tab keeps a deep history so switching away and back (the session
      // stays mounted, CSS-hidden) preserves a useful scrollback rather than
      // xterm's 1000-line default.
      scrollback: 10000,
      // xterm defaults this to 0, which applies every wheel/trackpad scroll as
      // an instant whole-line jump. Under macOS trackpad momentum (a stream of
      // sub-cell pixel deltas) that reads as choppy line-by-line stepping. A
      // short animated transition interpolates each scroll, giving the fluid
      // momentum feel users expect (mirrors VS Code's smooth-scrolling default).
      smoothScrollDuration: 125,
      // Faster scrollback travel per wheel notch (xterm defaults to 1 line),
      // tuned toward native terminals like Ghostty. Mouse-mode TUIs use the
      // separate accumulator below, scaled by its own `sensitivity`.
      scrollSensitivity: 3,
      // OSC 8 explicit hyperlinks (`ls --hyperlink`, agent tooling). xterm core
      // renders them; route activation to the OS browser. `allowNonHttpProtocols`
      // stays off (default), so only http(s) URIs reach here — nothing untrusted
      // is handed to `openExternal` beyond what its scheme allowlist permits.
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
    // Implicit http(s) URL detection. Route clicks explicitly to the OS browser
    // (scheme-allowlisted in main) instead of relying on xterm's default
    // window.open → asset-safety-net bounce.
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri)));

    term.open(container);

    // Clickable file paths: a custom provider detects POSIX path tokens in
    // hovered rows, validates them against the project (page-list cache →
    // checkTargetExists), and routes clicks — OK docs open in the editor, other
    // files OS-delegate. Disposed on teardown alongside the terminal.
    const activateFileLink = (target: TerminalLinkTarget) => {
      // NOTE: unlike `openUrl`, file-path links are NOT gated on mouse tracking.
      // A TUI like the `claude` TUI opens URLs itself (hence the URL deferral to
      // avoid a double-open) but does NOT open file paths, so the terminal must
      // still handle a file-path click even while that TUI owns the mouse.
      switch (target.kind) {
        case 'doc':
          window.location.hash = hashFromDocName(filePathToDocName(target.relPath));
          return;
        case 'folder':
          window.location.hash = hashFromFolderPath(target.relPath);
          return;
        case 'external':
          // A path outside the project — main pops a "reveal in Finder?" dialog
          // (the confirmation is the security gate for touching an out-of-project
          // location) and reveals on confirm.
          void bridge.shell
            .revealExternal(target.absPath)
            .catch((err) => console.warn('[terminal] revealExternal failed:', err));
          return;
        case 'asset':
          void bridge.shell
            .openAsset(target.relPath)
            .then((result) => {
              if (result.ok) return;
              // `extension-blocked` means the file exists but OK refuses to hand a
              // scripted/executable type to the OS opener — reveal it instead so
              // the click isn't a silent no-op (mirrors dispatchAssetClick).
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
          // Exhaustiveness: a new TerminalLinkKind must add a case above.
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
          // Stitch the wrapped logical line: a row longer than `term.cols` is
          // stored across multiple buffer rows, continuations flagged
          // `isWrapped`. Walk back to the logical start, forward to the end, and
          // join each row at full width (`translateToString(false)` pads to
          // `cols`) so the joined offsets map cleanly back to buffer cells. A
          // single row that reads just the hovered line would split a long path
          // (an absolute path in a narrow docked terminal) into non-resolving
          // fragments — the bug this fixes.
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

    // Under the Electron smoke suite (main injects `--ok-e2e-smoke=1`, surfaced
    // as `config.e2eSmoke`), skip the WebGL canvas renderer and use xterm's DOM
    // renderer. The canvas paints to a <canvas> the DOM-based smoke assertions
    // cannot read (.xterm-rows / .xterm-accessibility) and it captures focus so
    // synthetic keystrokes never reach the PTY. Gating only xterm here keeps
    // Electron's GPU acceleration on (unlike a blanket --disable-gpu, whose
    // whole-app software rendering starves CPU on constrained CI runners). The
    // DOM renderer is a real production path — it is also the fallback below.
    const useDomRenderer = bridge.config.e2eSmoke === true;
    if (!useDomRenderer) {
      // The webgl renderer needs a WebGL2 context; environments without one
      // (some VMs, software rendering) throw on activate — fall back to xterm's
      // DOM renderer instead of failing the mount.
      try {
        const webgl = new WebglAddon();
        // The browser caps live WebGL contexts (~8-16 per page). Since there is no
        // tab cap and every session stays mounted, the compositor can evict an
        // older tab's context at any time. Without this listener the evicted tab
        // would keep a dead canvas — blank output while its PTY keeps draining —
        // and look like a hung shell. Disposing lets xterm fall back to its DOM
        // renderer so the tab stays functional (slower) instead of going dead.
        webgl.onContextLoss(() => {
          console.warn('[terminal] WebGL context lost, falling back to DOM renderer');
          webgl.dispose();
        });
        term.loadAddon(webgl);
      } catch (err) {
        // A missing WebGL2 context (VM, software rendering) is the expected,
        // benign case; anything else (an addon/constructor regression after an
        // xterm bump) should surface louder so it is not mistaken for it.
        const expected = err instanceof Error && /webgl2?|context/i.test(err.message);
        const log = expected ? console.warn : console.error;
        log('[terminal] WebGL addon failed, using DOM renderer:', err);
      }
    }

    fit.fit();

    // Same-frame repaint after anything clears the canvas bitmap — see
    // terminal-render-flush.ts for the full why (canvas resize clears by
    // spec; xterm's own repaint is a frame late).
    const repaintSameFrame = createSameFrameRepaint(term);

    // The WebGL addon watches its canvas with a device-pixel-content-box
    // ResizeObserver and, when the device-pixel snap of a fractional CSS width
    // differs from the bitmap the grid resize set, re-sets canvas.width — a
    // SECOND clear that lands in a later RO delivery iteration of the same
    // frame (deeper target), i.e. AFTER the fit-path repaint. Observing the
    // same canvas with the same box, registered after the addon, puts this
    // callback after the addon's in that iteration, so the flush repaints
    // after its clear. Drawing to the bitmap changes no layout, so this adds
    // no further RO iterations. The DOM renderer path has no canvas and never
    // wires this.
    const webglCanvas = container.querySelector<HTMLCanvasElement>('.xterm-screen canvas');
    if (webglCanvas !== null) {
      canvasPixelObserver = new ResizeObserver(() => repaintSameFrame());
      try {
        canvasPixelObserver.observe(webglCanvas, { box: 'device-pixel-content-box' });
      } catch (err) {
        // Electron is always Chromium, which supports device-pixel-content-box
        // — so any throw here is unexpected (detached canvas, a future API
        // change), and it silently disables the flicker fix. Surface it so the
        // symptom (resize flicker returns) is correlatable in logs; the addon's
        // own sibling observer degrades the same way, so wiring stays off.
        console.warn('[terminal] device-pixel canvas observe failed:', err);
        canvasPixelObserver.disconnect();
        canvasPixelObserver = undefined;
      }
    }

    // Surface OSC 0/2 title changes the running program emits (shell prompt,
    // `vim`, the `claude` TUI) so the dock can label the tab with what the
    // program reports. Kept latest-ref so a new callback identity does not
    // respawn the PTY. Registered before create() since the first title can
    // arrive with the shell's very first output.
    titleDisposable = term.onTitleChange((title) => {
      if (!cancelled) onTitleChangeRef.current?.(title);
    });

    // Every renderer-to-PTY input path shares this gate. An adopted session is
    // wired before its replay is parsed so live output queues behind the replay,
    // but neither parser replies nor user gestures may reach the surviving shell
    // until that parse finishes. Exit closes the gate permanently for this run.
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

    // Every key (including Escape) goes to the PTY so terminal apps (vim, the
    // `claude` TUI) work — the keyboard exit is ⌘J. Linux owns the conventional
    // Ctrl+Shift+C/V clipboard chords; Windows additionally makes Ctrl+C copy
    // only when xterm has a selection and treats both Ctrl+V chords as paste.
    // A selection-free Ctrl+C still runs through xterm as an interrupt. The
    // remaining two Shift-chord patches are shared across platforms:
    //
    //  - Shift+Tab: xterm emits the reverse-tab sequence (ESC [ Z) but, unlike
    //    plain Tab, does NOT call preventDefault, so the browser's
    //    focus-previous fires and pulls focus out of the terminal. The Claude
    //    TUI binds Shift+Tab (mode cycling). Cancel the browser default and
    //    return true so xterm still emits the sequence to the PTY.
    //  - Shift+Enter: plain Enter sends CR (\r), which input-aware CLIs treat as
    //    submit. Send LF (\n) instead so the Claude TUI inserts a soft newline
    //    rather than submitting — matching how Ghostty / Cursor map this chord.
    //    Return false so xterm does NOT also emit its default \r.
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
        // Prevent Electron's hidden native Edit menu from consuming Ctrl+C/V.
        // Returning true still tells xterm to encode the key for the PTY.
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
        // Before a PTY exists, let xterm handle the key normally. Once a PTY id
        // exists, suppress xterm's CR and route the LF through the interaction
        // gate so replay cannot leak it into a surviving shell.
        if (ptyId === null) return true;
        event.preventDefault();
        sendInput('\n');
        return false;
      }
      return true;
    });

    // Mouse-mode wheel scrolling. When a full-screen TUI (claude, vim, less)
    // enables mouse tracking, xterm forwards the wheel to the app as one mouse-
    // wheel report PER OS wheel event, with no accumulation — so the high-
    // frequency event stream from trackpad momentum / free-spin wheels floods
    // the app and reads as jumpy "rocket scroll". We instead accumulate rows of
    // travel and emit one report per whole row crossed (see terminal-wheel.ts).
    // Scoped to apps that have mouse tracking on AND negotiated SGR (1006/1016)
    // encoding — the format the reports below use. mouseTrackingMode only tells
    // us tracking is on, not which byte encoding the app expects; an app can
    // track with the legacy X10/DEFAULT encoding, which our SGR reports would
    // corrupt. Those (and normal no-tracking scrollback) stay on xterm's own
    // path, which encodes correctly for the active protocol.
    let wheelRowAccumulator = 0;
    // The cell-height read below walks a private xterm internal. Warn once (not
    // per-event) if it ever returns undefined so a future xterm bump that moves
    // this surface shows up in QA instead of silently degrading to the fallback.
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
        wheelRowAccumulator = 0; // reset between gestures/apps; defer to xterm
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
        // Coordinate hit-testing TUIs (opencode/opentui, bubbletea) scroll the
        // component under the reported cell, so the report must carry the
        // pointer's position — `.xterm-screen` is the cell-grid origin (the
        // outer element adds padding/scrollbar). wheelReportPosition degrades
        // to viewport center when the rect or cell width isn't measurable.
        // rect is undefined exactly when there is no element to measure
        // (getBoundingClientRect itself never returns undefined).
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

    // First byte from the shell: drop the pending notice. Idempotent — the data
    // subscription fires per chunk, and an adopted session replays its retained
    // screen through here too. Unlike the cross-effect input gate above,
    // nothing outside this effect reads this state, so its lifetime is the
    // session effect rather than the component instance.
    let sawFirstOutput = false;
    const markFirstOutput = () => {
      if (sawFirstOutput) return;
      sawFirstOutput = true;
      setHasOutput(true);
    };

    // Wire a now-live ptyId (freshly created OR adopted from a survivor) into
    // this session: route xterm I/O, exit, and resize through it. The acquisition
    // branch marks it interactive only when input can safely reach the shell.
    // The wiring is identical for both acquisition paths — only how the id is
    // obtained differs — so both branches below call this.
    // A const arrow (not a hoisted `function`) so it observes the non-null
    // `container` narrowed by the early return above.
    const attachSession = (livePtyId: string): void => {
      ptyId = livePtyId;
      ptyIdRef.current = livePtyId;
      // Report the live id up so the host can reuse this session for a later
      // "Ask AI" launch (write into this PTY) instead of opening a new tab.
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
        // Ack consumed code units only once xterm has processed the chunk, so
        // the main-side backpressure window tracks real consumption.
        term.write(msg.data, () => bridge.terminal.drain(msg.ptyId, msg.data.length));
        // Watch for a startup-injection CLI's ready marker (no-op unless armed).
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

      // Fit runs on every resize event so the grid stays glued to the panel
      // edge (throttling it steps the canvas — visible flicker during drags);
      // it is cheap per event since FitAddon reflows only when a cell boundary
      // is crossed. The PTY resize is the throttled half: unthrottled, a drag
      // SIGWINCHes the running TUI into a full repaint whose output floods
      // back through IPC + render on every pointer frame — the drag lag users
      // hit with a terminal open. Leading call keeps a lone resize instant;
      // the trailing call always lands the final size (the kernel skips the
      // SIGWINCH when dimensions are unchanged, so redundant sends are inert).
      ptyResizeThrottle = createResizeThrottle(() => {
        if (ptyId) bridge.terminal.resize(ptyId, term.cols, term.rows);
      }, PTY_RESIZE_THROTTLE_MS);
      observer = new ResizeObserver(() => {
        const colsBefore = term.cols;
        const rowsBefore = term.rows;
        fit.fit();
        if (term.cols !== colsBefore || term.rows !== rowsBefore) {
          // Repaint first, then restore — for as long as the flush is
          // synchronous. `repaintSameFrame` flushes xterm's render debouncer,
          // and `_innerRefresh` ends by running the refresh callbacks, which is
          // where the viewport has queued the scroll-area sync that sets the
          // scrollbar's dimensions. So the flush is what re-derives those
          // dimensions against the new grid, and a restore running ahead of it
          // would re-assert a position against dimensions still describing the
          // old one.
          //
          // That last part is CONDITIONAL, so do not read it as an invariant.
          // The debouncer is a guarded internal: when a bump moves it,
          // `createSameFrameRepaint` warns and defers the refresh — and the
          // dimension sync riding on it — to the next frame, which puts the
          // restore back ahead of the sync. Nothing here detects that; the
          // warning is the signal, and in that state the panel has already lost
          // its same-frame repaint too.
          repaintSameFrame();
          restoreScrollReach(term);
        }
        ptyResizeThrottle?.request();
      });
      observer.observe(container);

      // No readiness probe here: attachSession runs for every session, including
      // plain and adopted tabs. Readiness feedback is scoped to a fresh,
      // product-initiated Claude launch, so only `resolveLaunchCommand` produces
      // the verdict while resolving that launch.
    };

    // "Open in <Agent>" launch: resolve the payload BEFORE create so the host
    // bakes it into shell startup rather than typing it through the live line
    // editor. POSIX carries its existing composed string; Windows carries
    // structured argv and injects user prompt text only after the TUI starts.
    // Both paths bypass persistent shell history and remain interactive on exit.
    //
    // The bake is gated on a CLI confirmed present on PATH — exactly today's
    // guarantee that the terminal never shows a raw `command not found`. Any
    // other verdict returns undefined (spawn a plain shell) and surfaces a
    // banner keyed to what the probe actually established: verified `not-found`
    // gets the actionable not-installed banner, while a still-`unknown` probe or
    // a rejected preflight IPC gets the distinct unverified strip (presenting an
    // unverified verdict as absence is the conflation the probe's producer
    // contract forbids). This function is the ONLY producer of the claude
    // readiness verdict (launch-less sessions carry no claude intent and never
    // probe — see attachSession). The claude probe here doubles as the
    // launch-time MCP pre-approval check — as fresh as the on-disk `.mcp.json`
    // gets, since it runs immediately before the spawn.
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
            // Own the readiness verdict for this launch session: surfaces the
            // rewire banner when OK tools need rewiring, and stays silent when
            // fully wired.
            if (!cancelled) setReadiness(fresh);
            return buildLaunch({
              mcpPreApprove: fresh.mcpPreApprovable === true,
              // Auto-approve OK's tools only when the project's `.mcp.json` entry is
              // verified OK's own (same gate as server-trust): auto-approving an
              // unverified/foreign same-named server's tools is the RCE risk
              // `isOwnManagedEntry` exists to prevent.
              autoApproveOkTools: autoApproveOkToolsRef.current && fresh.mcpPreApprovable === true,
            });
          }
          // Not confirmed present — suppress the bake and surface feedback. A
          // verified `not-found` gets the readiness banner's actionable
          // not-installed message; a lingering `unknown` is an UNVERIFIED
          // verdict, and the probe's producer contract forbids rendering a
          // "not installed" claim off it — it gets the distinct unverified
          // strip instead.
          if (!cancelled) {
            if (fresh.claude === 'not-found') {
              setReadiness(fresh);
            } else {
              setCliNotice({ cli: 'claude', kind: 'unverified' });
            }
          }
        } catch (err) {
          console.warn('[terminal] claude launch preflight failed', err);
          // The preflight IPC itself failed, so presence was never verified —
          // same unverified state as a still-unknown probe, never a fabricated
          // not-found.
          if (!cancelled) setCliNotice({ cli: 'claude', kind: 'unverified' });
        }
        return undefined;
      }
      // codex / cursor / opencode: confirm on PATH, re-probing once on a flaky
      // `unknown`, before baking — so a genuinely-absent binary shows the banner.
      try {
        let res = await bridge.terminal.cliPreflight(intent.cli);
        if (res.onPath === 'unknown') {
          if (cancelled) return undefined;
          res = await bridge.terminal.cliPreflight(intent.cli);
        }
        if (res.onPath === 'present') {
          // Codex auto-approve rides three gates: the user preference, codex on
          // PATH (this branch), AND OK's server already configured in codex —
          // else the `-c` override would break codex's config load. Other CLIs
          // (cursor/opencode/pi) never receive it.
          return buildLaunch({
            autoApproveOkTools:
              intent.cli === 'codex' &&
              res.okServerConfigured === true &&
              autoApproveOkToolsRef.current,
          });
        }
        // A verified `not-found` gets the actionable missing-CLI banner; a
        // still-unknown probe stays UNVERIFIED and must not be presented as
        // absence (the probe's producer contract) — distinct strip instead.
        if (!cancelled) {
          setCliNotice({
            cli: intent.cli,
            kind: res.onPath === 'not-found' ? 'not-found' : 'unverified',
          });
        }
      } catch (err) {
        console.warn('[terminal] cliPreflight failed', { cli: intent.cli, err });
        // IPC failure: presence was never verified — same unverified state.
        if (!cancelled) setCliNotice({ cli: intent.cli, kind: 'unverified' });
      }
      return undefined;
    };

    let stagePasteTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      // Reload rehydration: a tab restored from a surviving session carries its
      // ptyId. Adopt it (reconnect the live shell) rather than spawning a fresh
      // one, so the running program and its live I/O survive the reload. If the
      // shell exited in the gap before this mount, adopt is refused and we fall
      // through to a fresh create.
      if (adoptPtyId !== null) {
        let adopted: Awaited<ReturnType<typeof bridge.terminal.adopt>>;
        try {
          adopted = await bridge.terminal.adopt(adoptPtyId);
        } catch (err) {
          console.error('[terminal] adopt() failed:', err);
          adopted = { ok: false, reason: 'unknown-session' };
        }
        // Cancelled mid-adopt: the surviving session is still alive in main (we
        // only resumed it), so leave it for the next mount to re-adopt — do NOT
        // kill it the way a cancelled create reaps the orphan it just made.
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
          // Subscribe to live output before replay so bytes emitted during the
          // restore queue behind it in xterm. Input forwarding stays gated until
          // xterm finishes parsing the replay: retained terminal queries can make
          // xterm emit replies that belong to screen reconstruction, and sending
          // those replies into the live shell corrupts its line editor. This also
          // suppresses replies to queries first emitted while the renderer was
          // absent, which nothing else will answer. Separating those replies
          // would require preserving the undelivered outbound-suffix boundary
          // that adoptSession (main's terminal-manager) currently drops when
          // returning one replay string.
          const replay = adopted.replay;
          const hasReplay = replay !== '';
          // Keep the panel in its non-interactive starting state while replay
          // owns xterm's parser. The input gate cannot distinguish a protocol
          // reply from a real keystroke, so advertising `running` here would let
          // user input race the gate and be dropped mid-command.
          attachSession(adoptPtyId);
          if (hasReplay) {
            markFirstOutput();
            term.write(replay, markInteractive);
          } else {
            markInteractive();
          }
          // Nudge the surviving shell to repaint at the current viewport so a
          // full-screen TUI redraws its screen after the reload. Output from the
          // resize queues behind replay in xterm's FIFO write buffer.
          bridge.terminal.resize(adoptPtyId, term.cols, term.rows);
          return;
        }
        // The surviving session is gone — fall through and spawn a fresh shell.
      }

      // Resolve the baked launch command (preflight gates it) before create.
      // Only for a freshly-spawned launch tab: a failed adopt (adoptPtyId set but
      // the survivor is gone) must NOT re-issue the original launch — matching the
      // prior behavior where a re-mounted launch session never replayed its intent.
      let launchCommand: string | TerminalLaunchCommand | undefined;
      if (launch !== null && adoptPtyId === null) {
        launchCommand = await resolveLaunchCommand(launch);
        if (cancelled) return;
      } else if (commandId !== null && adoptPtyId === null) {
        // A "run this command" tab. No preflight: the command is a constant
        // from a closed union, not a CLI we have to find on PATH first — and
        // the login shell the spawn already uses is what makes a global npm
        // install resolvable from a GUI-launched app. Same adopt guard as
        // above, so a failed adopt never silently re-runs the command.
        launchCommand =
          bridge.platform === 'win32'
            ? windowsTerminalCommandFor(commandId)
            : terminalCommandFor(commandId);
      }

      let result: Awaited<ReturnType<typeof bridge.terminal.create>>;
      try {
        result = await bridge.terminal.create({ cols: term.cols, rows: term.rows, launchCommand });
      } catch (err) {
        // Surface for diagnostics: with multi-session a create() failure in one
        // tab is less visible (other tabs keep streaming), so log it like the
        // WebGL catch above rather than only showing the per-tab exit notice.
        console.error('[terminal] create() failed:', err);
        // create() can reject before any PTY exists — `utilityProcess.fork`
        // throwing synchronously on resource exhaustion, or an IPC failure.
        // Without this catch the rejection is unhandled and `status` stays
        // `'starting'`, leaving a permanently blank terminal. Surface the same
        // error/restart state the panel shows for a runtime crash.
        if (cancelled) return;
        setExitInfo({
          exitCode: 1,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
        });
        setStatus('exited');
        return;
      }

      // The effect may have been cleaned up while create() was in flight
      // (fast toggle, StrictMode remount). Reap the orphaned PTY and bail.
      if (cancelled) {
        if (result.ok)
          void bridge.terminal
            .kill(result.ptyId)
            .catch((err) => console.warn('[terminal] kill after cancelled mount failed:', err));
        return;
      }
      if (!result.ok) {
        // Main refused the spawn. Surface why via an explicit notice rather
        // than leaving the bare (focused) canvas — the two reasons are distinct
        // and recoverable in different ways. Do NOT focus the dead canvas.
        setStatus(result.reason === 'not-consented' ? 'not-consented' : 'no-project');
        return;
      }

      attachSession(result.ptyId);
      markInteractive();

      // Stage the ⌘J/⇧⌘J selection into the freshly-launched CLI's input — once,
      // and NOT submitted. A suppressed launch or capability-limited Windows
      // shell is a BARE shell where every staged `\n` would EXECUTE as a command,
      // so the passage is dropped. The short beat lets the TUI's stdin reader
      // attach (a write at raw PTY-live can race it); unmount cancels the timer.
      const staged = launch?.stagePaste;
      // Hermes on POSIX and every Windows CLI launch promptless, then receive the
      // composed prompt HERE as a bracketed-paste PTY write once the TUI's stdin
      // reader has attached. inject() owns the capability gate because the host's
      // notice can arrive after create resolves but before the settle timer fires.
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
          // Inject once the input widget signals ready (Hermes: bracketed-paste
          // enable), then a short debounce — pasting the instant it's live instead
          // of guessing a fixed boot time.
          let acc = '';
          readinessScan = (data) => {
            if (fired || stagePasteTimer !== undefined) return;
            acc += data;
            if (acc.includes(marker)) {
              readinessScan = undefined;
              stagePasteTimer = setTimeout(inject, settleMs);
              return;
            }
            // Bound the buffer, keeping enough tail to catch a marker split across
            // chunks. Trim only after a non-match so an early-in-a-big-chunk marker
            // is never sliced away before the includes() check above.
            if (acc.length > marker.length + 256) acc = acc.slice(-(marker.length + 256));
          };
        } else {
          // No marker configured — a fixed beat from spawn (legacy behavior).
          stagePasteTimer = setTimeout(inject, settleMs);
        }
      } else if (launch != null && launch.prompt != null && staged != null) {
        // `prompt` and `stagePaste` are mutually exclusive by the intent's
        // contract (the type doesn't forbid it — single producer today). A
        // future producer setting both would double-dispatch: the prompt
        // auto-runs at spawn AND the paste lands in the input. The baked
        // prompt wins; surface the contract violation instead of silently
        // double-writing.
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
      // This session no longer has a live PTY — clear it from the host's reuse
      // map so an "Ask AI" launch never writes into a torn-down shell.
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
      // BrowserWindow close and app quit reap in main. A renderer reload keeps
      // the window alive, so leave that PTY for the replacement renderer to
      // adopt instead of turning reload into a fresh shell.
      if (ptyId && !documentUnloading)
        void bridge.terminal
          .kill(ptyId)
          .catch((err) => console.warn('[terminal] kill on unmount failed:', err));
    };
    // adoptPtyId is stable for a session instance (a restart remounts via the
    // parent key rather than changing it), so listing it never re-runs this
    // mount/adopt effect — it only satisfies the exhaustive-deps check.
  }, [bridge, adoptPtyId, launch, commandId]);

  // Re-skin the live terminal when the app theme changes — light/dark AND the
  // color-theme layer (useLiveXtermTheme keeps identity stable until colors
  // actually change). Mutating `term.options.theme` re-paints in place, so an
  // open session follows theme switches without a restart (the PTY and
  // scrollback survive).
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = xtermTheme;
  }, [xtermTheme]);

  // Follow assistive-tech attach/detach in place: toggling
  // `term.options.screenReaderMode` builds or tears down xterm's a11y DOM
  // mirror without touching the PTY, so a screen reader started mid-session
  // gets the accessible tree without a restart. The smoke suite pins the mode
  // on (see the mount option above), so it never subscribes.
  useEffect(() => {
    const accessibility = bridge.accessibility;
    if (accessibility == null || bridge.config.e2eSmoke === true) return;
    return accessibility.onScreenReaderChanged((active) => {
      const term = termRef.current;
      if (term !== null) term.options.screenReaderMode = active;
    });
  }, [bridge]);

  // Drop a file onto the terminal -> insert its shell-escaped absolute path at
  // the prompt (VS Code / Cursor / JetBrains parity). We deliberately do NOT try
  // to attach images inline the way the `claude` TUI does over its own escape
  // protocol — writing the path is the reliable cross-terminal behavior, and the
  // CLI reads the file from disk. `webUtils.getPathForFile` (via the bridge) is
  // the only way to recover a dropped File's path since Electron dropped
  // `File.path`; a File with no disk backing (clipboard blob) yields null.
  // Native listeners on the container (not JSX props) mirror the FileSidebar's
  // external-drop handling so xterm's canvas can't swallow the event.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    function onDragOver(event: DragEvent) {
      if (!isExternalFileDrag(event)) return;
      // Suppress Electron's default: navigating the webview to the dropped file://.
      event.preventDefault();
    }
    function onDrop(event: DragEvent) {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      if (!terminalInputEnabledRef.current) return;
      const droppedFiles = filesFromExternalDrop(event);
      const paths = droppedFiles
        .map((file) => bridge.getPathForFile(file))
        // Drop any path carrying an ASCII control char (newline/CR/tab, etc).
        // The tty line discipline acts on those bytes before the shell sees the
        // quoting, so an embedded newline in a (legal, if exotic) filename would
        // submit a partial command into the live shell: command injection via a
        // dropped file. shellSingleQuote keeps them shell-inert but cannot stop
        // the tty from acting first. Codepoint scan (not a regex) so there is no
        // control-char-in-regex lint-disable to strip on the public mirror export.
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
      // Trailing space so a following drop or keystroke doesn't glue onto the
      // path; no newline — the user reviews the composed prompt before submitting.
      terminalInputRef.current(`${escapedPaths.join(' ')} `);
    }
    // Capture phase (mirrors FileTree's external-drop listeners) so the drop is
    // seen before xterm's canvas child can stopPropagation/preventDefault it.
    container.addEventListener('dragover', onDragOver, { capture: true });
    container.addEventListener('drop', onDrop, { capture: true });
    return () => {
      container.removeEventListener('dragover', onDragOver, { capture: true });
      container.removeEventListener('drop', onDrop, { capture: true });
    };
  }, [bridge]);

  return (
    // Column layout so the readiness banner is a strip ABOVE the terminal
    // (pushing the canvas down) rather than an overlay covering the prompt and
    // first output — FitAddon then sizes rows to the remaining space.
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
      {/* This wrapper exists so the pending notice covers the CANVAS only. The
          readiness / CLI banners above are gated on `status === 'running'`, and
          `resolveLaunchCommand` sets their verdicts BEFORE `create()` resolves,
          so on any CLI launch with a banner due the banner is mounted for the
          whole pre-first-byte window — a column-wide overlay hid it. The
          wrapper one level up in TerminalPanel would have served as a
          containing block, but it spans the column, and spanning the column is
          the bug. Per-class rationale lives on `TerminalStartingNotice`'s
          `className` prop. */}
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
