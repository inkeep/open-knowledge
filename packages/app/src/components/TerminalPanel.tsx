import '@xterm/xterm/css/xterm.css';

import {
  buildCliLaunchArgString,
  shellSingleQuote,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
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
import { filesFromExternalDrop, isExternalFileDrag } from './file-tree-adapter';
import { TerminalCliMissingBanner } from './TerminalCliMissingBanner';
import { type TerminalExitInfo, TerminalExitNotice } from './TerminalExitNotice';
import { TerminalRefusalNotice } from './TerminalRefusalNotice';
import { xtermThemeForMode } from './terminal-theme';
import { nextWheelReports, sgrWheelReport, wheelReportPosition } from './terminal-wheel';

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
  adoptPtyId = null,
  onPtyId,
}: TerminalPanelProps) {
  const { t } = useLingui();
  // Paint the panel chrome (the kill strip) with the exact xterm canvas color so
  // the strip and the terminal read as one surface — single source: terminal-theme.
  const { resolvedTheme } = useTheme();
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
  adoptPtyId = null,
  onPtyId,
}: TerminalSessionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  const onTitleChangeRef = useRef(onTitleChange);
  const onPtyIdRef = useRef(onPtyId);
  const { resolvedTheme } = useTheme();
  // Live xterm instance, exposed so the theme effect below can re-skin it in
  // place — re-theming must not tear down and respawn the PTY.
  const termRef = useRef<Terminal | null>(null);
  // Resolved theme captured at first render, used for the initial xterm
  // palette; later theme changes flow through the dedicated effect below.
  const initialResolvedThemeRef = useRef(resolvedTheme);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [readiness, setReadiness] = useState<ClaudeReadiness | null>(null);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);
  // Live PTY id, mirrored out of the mount effect for the keyboard handlers.
  const ptyIdRef = useRef<string | null>(null);
  // Set when a codex/cursor/opencode launch probed `not-found` on PATH — drives
  // the missing-CLI banner. Claude uses its own readiness banner instead.
  const [missingCli, setMissingCli] = useState<TerminalCli | null>(null);

  // Keep the callbacks fresh without re-running the mount effect — a new
  // callback identity must NOT tear down and respawn the PTY.
  useEffect(() => {
    onExitRef.current = onExit;
    onTitleChangeRef.current = onTitleChange;
    onPtyIdRef.current = onPtyId;
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
      theme: xtermThemeForMode(initialResolvedThemeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon());

    term.open(container);

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

    // Surface OSC 0/2 title changes the running program emits (shell prompt,
    // `vim`, the `claude` TUI) so the dock can label the tab with what the
    // program reports. Kept latest-ref so a new callback identity does not
    // respawn the PTY. Registered before create() since the first title can
    // arrive with the shell's very first output.
    titleDisposable = term.onTitleChange((title) => {
      if (!cancelled) onTitleChangeRef.current?.(title);
    });

    // Every key (including Escape) goes to the PTY so terminal apps (vim, the
    // `claude` TUI) work — the keyboard exit is ⌘J. Two Shift-chord patches:
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
      if (event.type !== 'keydown' || !event.shiftKey) return true;
      if (event.key === 'Tab') {
        event.preventDefault();
        return true;
      }
      if (event.key === 'Enter') {
        const ptyId = ptyIdRef.current;
        // Before the PTY is live there is nothing to write to; let xterm
        // handle the key with its default behavior.
        if (ptyId === null) return true;
        event.preventDefault();
        bridge.terminal.input(ptyId, '\n');
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
        bridge.terminal.input(ptyId, sgrWheelReport(button, position).repeat(count));
      }
      return false;
    });

    // Wire a now-live ptyId (freshly created OR adopted from a survivor) into
    // this session: route xterm I/O, exit, and resize through it, focus it, and
    // probe Claude readiness. The wiring is identical for both acquisition paths
    // — only how the id is obtained differs — so both branches below call this.
    // A const arrow (not a hoisted `function`) so it observes the non-null
    // `container` narrowed by the early return above.
    const attachSession = (livePtyId: string) => {
      ptyId = livePtyId;
      ptyIdRef.current = livePtyId;
      // Report the live id up so the host can reuse this session for a later
      // "Ask AI" launch (write into this PTY) instead of opening a new tab.
      onPtyIdRef.current?.(livePtyId);
      setStatus('running');

      term.onData((data) => {
        if (ptyId) bridge.terminal.input(ptyId, data);
      });

      unsubData = bridge.terminal.onData((msg) => {
        if (msg.ptyId !== ptyId) return;
        // Ack consumed code units only once xterm has processed the chunk, so
        // the main-side backpressure window tracks real consumption.
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

      // Surface Claude Code readiness once the shell is live. Best-effort UX —
      // a probe failure must never break the terminal, so swallow and show
      // nothing. Log first so a non-teardown failure isn't invisible.
      //
      // SKIP for a freshly-launched tab: `resolveLaunchCommand` already ran a
      // launch-time `claudePreflight` and owns the readiness verdict for that
      // session. Re-probing here would be a redundant IPC round-trip AND could
      // downgrade a launch-time `not-found` (banner shown) to a flaky `unknown`
      // (banner hides), making the missing-CLI banner flash then vanish with no
      // agent launched. Adopted sessions (adoptPtyId set) never call
      // `resolveLaunchCommand`, so they still need the probe.
      const launchOwnsReadiness = launch !== null && adoptPtyId === null;
      if (!launchOwnsReadiness) {
        bridge.terminal
          .claudePreflight()
          .then((readinessResult) => {
            if (!cancelled) setReadiness(readinessResult);
          })
          .catch((err) => {
            console.warn('[terminal] claude readiness preflight failed', err);
          });
      }
    };

    // "Open in <Agent>" launch: resolve the command we BAKE into the shell spawn
    // BEFORE create, so the agent rides on `$SHELL -l -i -c '<cmd>; exec …'` rather
    // than being typed into the live shell. A `-c` command never reaches the line
    // editor, so it is never written to the user's persistent history (the launch
    // clutter + doc-content-on-disk leak this fixes); the spawn's `exec` tail hands
    // the tab back to a fresh interactive shell after the agent exits.
    //
    // The bake is gated on a CLI confirmed present on PATH — exactly today's
    // guarantee that the terminal never shows a raw `command not found`. A not-
    // present / unknown / IPC-failure verdict returns undefined (spawn a plain
    // shell) and surfaces a banner: this function OWNS the claude readiness
    // verdict for a launch session (setting it on every path so the post-attach
    // probe is skipped — see attachSession), and sets the missing-CLI banner for
    // codex/cursor/opencode. The claude probe here doubles as the launch-time MCP
    // pre-approval check — as fresh as the on-disk `.mcp.json` gets, since it runs
    // immediately before the spawn.
    const resolveLaunchCommand = async (
      intent: TerminalLaunchIntent,
    ): Promise<string | undefined> => {
      if (intent.cli === 'claude') {
        try {
          const fresh = await bridge.terminal.claudePreflight();
          if (fresh.claude === 'present') {
            // Own the readiness verdict for this launch session (the post-attach
            // probe is skipped for launches): surfaces the rewire banner when OK
            // tools need rewiring, and stays silent when fully wired.
            if (!cancelled) setReadiness(fresh);
            return buildCliLaunchArgString('claude', intent.prompt, {
              mcpPreApprove: fresh.mcpPreApprovable === true,
            });
          }
          // Not confirmed present (not-found OR unknown) — suppress the bake and
          // surface the readiness banner so the user always gets feedback. The
          // banner hides for `unknown` by design (a flaky probe must never show a
          // false "not installed"), so map a lingering `unknown` to not-found FOR
          // DISPLAY only — by here the launch-time verdict is treated as unconfirmed.
          if (!cancelled) {
            setReadiness(
              fresh.claude === 'not-found'
                ? fresh
                : { claude: 'not-found', mcp: fresh.mcp, mcpPreApprovable: false },
            );
          }
        } catch (err) {
          console.warn('[terminal] claude launch preflight failed', err);
          // Unconfirmed (IPC failure) → still surface the banner rather than a
          // silent no-op (there is no "couldn't verify" state).
          if (!cancelled) {
            setReadiness({ claude: 'not-found', mcp: 'needs-rewire', mcpPreApprovable: false });
          }
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
        if (res.onPath === 'present') return buildCliLaunchArgString(intent.cli, intent.prompt);
      } catch (err) {
        console.warn('[terminal] cliPreflight failed', { cli: intent.cli, err });
      }
      if (!cancelled) setMissingCli(intent.cli);
      return undefined;
    };

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
          // Repaint the pre-reload screen + scrollback the main process retained
          // for this PTY BEFORE wiring live delivery — without it the adopted tab
          // comes back blank (the shell reconnects but its
          // screen is gone). Written synchronously here, ahead of attachSession's
          // onData subscription, so no live byte can interleave before the replay.
          if (adopted.replay) term.write(adopted.replay);
          attachSession(adoptPtyId);
          // Nudge the surviving shell to repaint at the current viewport so a
          // full-screen TUI (claude, vim) redraws its screen after the reload.
          bridge.terminal.resize(adoptPtyId, term.cols, term.rows);
          return;
        }
        // The surviving session is gone — fall through and spawn a fresh shell.
      }

      // Resolve the baked launch command (preflight gates it) before create.
      // Only for a freshly-spawned launch tab: a failed adopt (adoptPtyId set but
      // the survivor is gone) must NOT re-issue the original launch — matching the
      // prior behavior where a re-mounted launch session never replayed its intent.
      let launchCommand: string | undefined;
      if (launch !== null && adoptPtyId === null) {
        launchCommand = await resolveLaunchCommand(launch);
        if (cancelled) return;
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
    })();

    return () => {
      cancelled = true;
      ptyIdRef.current = null;
      // This session no longer has a live PTY — clear it from the host's reuse
      // map so an "Ask AI" launch never writes into a torn-down shell.
      onPtyIdRef.current?.(null);
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
    // adoptPtyId is stable for a session instance (a restart remounts via the
    // parent key rather than changing it), so listing it never re-runs this
    // mount/adopt effect — it only satisfies the exhaustive-deps check.
  }, [bridge, adoptPtyId, launch]);

  // Re-skin the live terminal when the app theme changes. Mutating
  // `term.options.theme` re-paints in place, so an open session follows
  // light/dark switches without a restart (the PTY and scrollback survive).
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = xtermThemeForMode(resolvedTheme);
  }, [resolvedTheme]);

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
      const livePtyId = ptyIdRef.current;
      if (livePtyId === null) return;
      const paths = filesFromExternalDrop(event)
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
      if (paths.length === 0) return;
      // Trailing space so a following drop or keystroke doesn't glue onto the
      // path; no newline — the user reviews the composed prompt before submitting.
      bridge.terminal.input(livePtyId, `${paths.map(shellSingleQuote).join(' ')} `);
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
