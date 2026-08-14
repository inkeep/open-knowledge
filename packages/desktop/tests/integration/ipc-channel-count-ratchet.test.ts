/**
 * Mechanical ratchet for the hand-rolled IPC channel surface.
 *
 * `ipc-channels.ts`'s file header commits the team to migrating off the
 * hand-rolled discriminated union (to `@egoist/tipc` or
 * `@electron-toolkit/typed-ipc`) BEFORE adding any further channels — the
 * channel count is well past the scale-match trigger documented in the
 * header. Without a CI gate, that commitment is purely social: a future
 * contributor can add another channel and the typed-ipc migration silently
 * defers.
 *
 * The ratchet parses the `RequestChannels` interface declaration in
 * `ipc-channels.ts`, counts the channel-key entries (`'ok:<surface>:<verb>'`),
 * and fails when the count exceeds the committed cap. Forward direction:
 * the cap moves with intentional changes to the cap constant, not with
 * incidental channel additions.
 *
 * Mirrors `no-loosely-typed-webcontents-ipc.test.ts`'s shape — a Vitest test
 * with grep-walk over the source. Same enforcement guarantee, same `pnpm
 * check` gating.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_PATH = join(__dirname, '..', '..', 'src', 'shared', 'ipc-channels.ts');
const CHANNELS_SRC = readFileSync(SRC_PATH, 'utf-8');

/**
 * Maximum hand-rolled request channels permitted before the typed-ipc
 * migration must land. Bumped from 55 to 59 with four channels added by
 * the share-receive branch-aware flow:
 *
 *   - `ok:project:read-head-branch` — pre-server branch-mismatch
 *     detection. Reads `<projectPath>/.git/HEAD` directly from main; no
 *     server is running yet at silent-dispatch time, so the existing
 *     `GET /api/git/branch-info` HTTP read is unreachable.
 *   - `ok:project:fetch-branch-info` — proxies `GET /api/git/branch-info`
 *     against the project's running server. Main owns the HTTP call
 *     because the dispatcher window does not carry the project's
 *     apiOrigin; the proxy resolves the server lock and routes the GET.
 *   - `ok:project:run-checkout` — proxies `POST /api/git/checkout` for
 *     the same dispatcher-to-project routing reason as fetch-branch-info,
 *     but for the write surface. Returns immediately on git success; the
 *     post-checkout wait is an orthogonal channel.
 *   - `ok:project:await-branch-switched` — gates the dialog's dismissal
 *     on the CC1 `branch-switched` broadcast landing in the project
 *     window. Main polls the project's `GET /api/server-info` (the
 *     late-join backstop for the broadcast) until `currentBranch`
 *     matches. Could not fold into `run-checkout` because the dialog
 *     flows through `runCheckout` → `awaiting-cc1-recycle` →
 *     `awaitBranchSwitched` as separate reducer phases — folding would
 *     couple the write-response timing to the broadcast-wait timing.
 *
 * Bumped from 59 to 60 with the stale-branch fix:
 *
 *   - `ok:project:check-target-exists` — pre-server target-existence
 *     probe. After the branch-name comparison passes, probes
 *     `<projectPath>/<docPath>` on the working tree. Without this gate,
 *     a receiver whose locally checked-out branch matches the share but
 *     hasn't fetched the commit that adds the file (typical stale-branch
 *     scenario) silently opens a blank editor. Could not fold into
 *     `read-head-branch` because the two probes have orthogonal
 *     responsibilities (branch state vs file presence) and folding
 *     would conflate the schemas; the cost is one channel, the win is
 *     a clean single-responsibility surface that's easy to test in
 *     isolation.
 *
 * Bumped from 60 to 62 with the multi-worktree share-receive flow:
 *
 *   - `ok:project:list-git-worktrees` — runs `git worktree list
 *     --porcelain` rooted at an anchor path and returns realpath-collapsed
 *     entries. The candidate-selection algorithm needs to see worktrees
 *     beyond the Recents list (CLI-managed worktrees the user has never
 *     opened in OK still become first-class share-receive candidates).
 *     Could not fold into `read-head-branch` because the responsibilities
 *     differ — that probe reads ONE worktree's HEAD; this one enumerates
 *     ALL worktrees in the repo. Different shapes, different failure
 *     modes (parser-tolerance vs symbolic-ref parsing).
 *   - `ok:project:read-git-dir-kind` — classifies `<projectPath>/.git`
 *     as `'directory'` (main checkout), `'linked'` (worktree pointer),
 *     or `'absent'` / `'malformed-pointer'` / `'inaccessible'`. Used by
 *     the candidate-selection fallback to prefer main checkouts over
 *     linked worktrees when no branch-match exists (switching main is
 *     safe; switching a worktree off its branch defeats its purpose).
 *     A thin wrapper around `resolveGitDirDetailed` from core — chosen
 *     over a richer combined `inspectCandidate` IPC to preserve
 *     composability (separate `readHeadBranch` + `readGitDirKind` +
 *     `findEnclosingProjectRoot` calls reuse existing primitives;
 *     a combined call would duplicate logic and complicate testing).
 *
 * Bumped from 62 to 63 with the multi-worktree share-receive
 * consent flow's Navigator transport:
 *
 *   - `ok:project:ok-init` — runs the share-receive scaffold
 *     (`initContent`) directly from main. The HTTP route
 *     `POST /api/local-op/ok-init` exists for the Editor-App-window
 *     code path, but the consent dialog mounts in the Navigator
 *     window before any project utility server exists for the
 *     candidate path. The Navigator's `apiOrigin === ''`, so a
 *     relative fetch would never reach a server — sibling Navigator
 *     flows (`localOp.clone`, `localOp.auth.*`) ship IPC transports
 *     for exactly this constraint. Could not fold into
 *     `read-git-dir-kind` or `find-enclosing-project-root` because
 *     this is the only write surface among the share-receive
 *     candidate-selection IPCs — folding would mix a mutator into
 *     a read-only group.
 *
 * All eight of the share-receive additions extend the existing
 * `bridge.project.*` namespace rather than introducing new top-level
 * channel namespaces. The typed-ipc migration remains deferred; raising
 * the cap again must coincide with either the migration landing or
 * another scoped exception with the same explicit commitment update in
 * the `ipc-channels.ts` header comment.
 *
 * Bumped from 63 to 64 with the multi-worktree share-receive dedupe fix:
 *
 *   - `ok:project:realpath` — canonicalizes a path via the OS realpath so
 *     the candidate-selection step can collapse Recents paths (stored as
 *     the user opened them, possibly pre-canonical) onto the same realpath
 *     identity `list-git-worktrees` already emits. Without it, a Recents
 *     entry at `/var/...` and a worktree-enum entry at `/private/var/...`
 *     (the same physical dir on macOS) produce two Candidate rows for one
 *     directory, spuriously flipping `multiCandidate` true and firing the
 *     ambiguous-branch-match diagnostic on a non-ambiguity. The renderer
 *     is pure (no `node:fs`), so canonicalization must cross to main.
 *     Could not fold into any sibling: it returns a bare `string`, whereas
 *     `read-git-dir-kind` returns a kind enum and `find-enclosing-*` return
 *     structured results — folding would conflate the schemas.
 *
 * Bumped from 64 to 65 for the OK config sharing-mode feature:
 *
 *   - `ok:sharing:dispatch` — single discriminated-args channel covering both
 *     the read (`status`) and the write (`set-mode`) for the per-project
 *     sharing toggle. Consolidated into one channel so the addition is
 *     +1 instead of +2. Could not fold into existing project channels:
 *     none of them carry a discriminated-payload precedent today, and
 *     `ok:state:query` returns a different shape that's already
 *     gated by an unrelated discriminant.
 *
 * Bumped from 65 to 66 with the desktop version-drift restart flow:
 *
 *   - `ok:project:restart-server` — terminates the attached (not-owned)
 *     server a window connected to and recreates the window against a fresh
 *     own-version spawn. Renderer-initiated from the version-drift
 *     notification's action button. Could not fold into `ok:project:open`:
 *     that channel focuses an already-open project and requires a Navigator
 *     `entryPoint`, whereas restart is invoked from an editor window for the
 *     project it is already attached to, and it must first terminate a
 *     running server (a destructive side effect alien to the open path).
 *     Could not fold into `ok:project:close` (no respawn, no result) or
 *     `ok:update:relaunch-now` (relaunches the whole app, not one project's
 *     server). It is the only channel whose result is consumed solely on
 *     failure — success recreates the originating window, so its invoke never
 *     resolves. Distinct direction, semantics, and result shape from all 65
 *     siblings. The typed-ipc migration remains the committed end state; this
 *     is a scoped exception with the header-comment commitment updated in
 *     lock-step (per the same rule the share-receive additions followed).
 *
 * Bumped from 66 to 71 with the docked-terminal `ok:pty:*` PTY surface:
 *
 *   - `ok:pty:create` — fork/spawn a window-bound PTY at the project root,
 *     returns the new ptyId (or `no-project`).
 *   - `ok:pty:input` / `ok:pty:resize` / `ok:pty:kill` — fire-and-forget
 *     keystroke / fit / teardown, keyed by ptyId.
 *   - `ok:pty:drain` — the renderer's backpressure ack (consumed byte count)
 *     gating node-pty `resume()` on a flood-paused PTY. No existing channel
 *     carries renderer→main flow-control semantics to fold it into; it is the
 *     no-precedent backpressure seam.
 *
 *   These could NOT fold into existing channels and could NOT collapse into
 *   each other: the STOP rule forbids any arbitrary-exec IPC outside the
 *   `ok:pty:*` framing, and the surface is the smallest faithful PTY protocol
 *   (create + the three per-keystroke verbs + the flow-control ack). Streaming
 *   output + exit ride `EventChannels` (`ok:pty:data` / `ok:pty:exit`), not
 *   here. The typed-ipc migration remains the committed end state; this is a
 *   scoped exception with the `ipc-channels.ts` header commitment updated in
 *   lock-step (per the same rule the share-receive + sharing additions followed).
 *
 * Bumped from 71 to 72 with the docked-terminal Claude Code readiness surface:
 *
 *   - `ok:terminal:claude-assist` — a SINGLE discriminated channel carrying
 *     both the `preflight` read (is `claude` on the login-shell PATH; is the
 *     `open-knowledge` MCP server wired into `~/.claude.json`) and the `rewire`
 *     action (show the MCP consent dialog so the user can wire it). Folded into
 *     one channel via the `ok:sharing:dispatch` discriminated-args precedent
 *     (+1, not +2). It is NOT an arbitrary-exec channel and so does NOT belong
 *     in the `ok:pty:*` framing: the renderer supplies only the `action`
 *     discriminant; main runs a FIXED `command -v claude` probe and arms the
 *     existing consent flow — no renderer-supplied command ever executes. Could
 *     not fold into `ok:pty:create` (per-spawn lifecycle, no readiness/rewire
 *     semantics) nor into the `ok:mcp-wiring:*` channels (those are the consent
 *     dialog's confirm/skip/ready responses, not a terminal-side trigger).
 *     The typed-ipc migration remains the committed end state; scoped exception
 *     with the `ipc-channels.ts` header commitment updated in lock-step.
 *
 * Lowered from 72 to 71 with the removal of the external-Terminal.app
 * `ok:shell:open-in-terminal` channel (the in-app docked terminal replaces it).
 * The ratchet tracks downward on genuine channel removals so the cap stays
 * tight against the actual surface.
 *
 * Bumped from 71 to 74 with the docked-terminal reload-survival surface
 * (sessions vanished from the dock after a renderer reload because the surviving
 * main-process PTYs were unreachable):
 *
 *   - `ok:pty:list` — the reload-rehydration inventory: the live ptyIds for the
 *     sender's window, so a reloaded dock rediscovers the shells that survived
 *     in main. A read returning an array; could not fold into `ok:pty:create`
 *     (per-spawn lifecycle, returns one NEW ptyId) — opposite direction and
 *     shape. Stays in `ok:pty:*` per the STOP rule (no exec surface elsewhere).
 *   - `ok:pty:adopt` — rebinds a surviving session to the reloaded renderer
 *     (refresh delivery target, clear the backpressure the dead page stranded,
 *     resume the host) and returns liveness so the panel falls back to a fresh
 *     create on a TOCTOU dead session. Could not fold into the fire-and-forget
 *     `input`/`resize`/`kill` (no result) nor `create` (spawns new) — it is a
 *     mutate-with-typed-result against an EXISTING shell. Stays in `ok:pty:*`.
 *   - `ok:terminal:dock-state` — reads the per-window dock visibility main
 *     retains (WRITTEN via the existing `ok:editor:view-menu-state-changed`
 *     push, so no new write channel) so a reloaded renderer restores an expanded
 *     dock. A read of UI-chrome state, orthogonal to `ok:terminal:claude-assist`
 *     (readiness/rewire) — folding would conflate two responsibilities.
 *
 *   All three extend existing namespaces (`ok:pty:*`, `ok:terminal:*`) rather
 *   than introducing new ones, and the visibility WRITE reused an existing
 *   channel rather than adding one. The typed-ipc migration remains the
 *   committed end state; this is a scoped exception with the `ipc-channels.ts`
 *   header commitment updated in lock-step.
 *
 * Bumped from 74 to 75 to reconcile a merge collision: two concurrently-approved
 * PRs each claimed the single free slot the base tree had at 74. The worktree
 * selector added `ok:worktree:dispatch` (already a fold — list + create ride one
 * discriminated dispatch channel, `ok:*` STOP framing keeps worktree ops off the
 * generic project surface), and the terminal-controls PR added
 * `ok:terminal:cli-installed-map` (extends the existing `ok:terminal:*`
 * namespace). Neither individually exceeded the cap; their union does. Both are
 * already reviewed and needed, and further folding worktree-dispatch into an
 * unrelated surface would be a worse design, so the cap moves to 75. The
 * typed-ipc migration remains the committed end state before any NET-NEW batch.
 *
 * Bumped from 75 to 76 merging the desktop startup-instrumentation surface,
 * which landed on main in parallel; the merge unions both new channels so the
 * cap follows their sum:
 *
 *   - `ok:startup:renderer-marks` — the renderer reports its two launch
 *     checkpoints (page-list ready, first content) as epoch-ms once both land,
 *     so main can fold them into the single `desktop.startup-timeline`
 *     waterfall log. A fire-and-forget push (`result: undefined`); could not
 *     fold into `ok:theme:applied` (a different signal on a different edge —
 *     theme-applied fires on the show-gate edge + matchMedia changes, these
 *     fire once content is usable) nor `ok:editor:*` (editor-area state, not a
 *     launch metric). New `ok:startup:*` namespace, single member.
 *
 * Bumped from 76 to 77 for the share-receive branch-switch dialog's verdict
 * pivot:
 *
 *   - `ok:project:fetch-target-status` — proxies `POST /api/share/target-status`
 *     so the dialog can fetch a real verdict (on-origin / renamed / deleted /
 *     never-on-branch / unknown) when the network-free origin hint is stale.
 *     Could not fold into `ok:project:fetch-branch-info` (a GET proxy that is
 *     deliberately network-free — the whole point of a separate endpoint is to
 *     keep branch-info's fast path off the network) nor `ok:project:run-checkout`
 *     (a POST that MUTATES the working tree; this is a read-only fetch+classify).
 *     Extends the existing `ok:project:*` namespace, single member.
 *
 * Bumped from 77 to 78 for Settings → AI tools (per-component
 * install/uninstall of OK's global footprint):
 *
 *   - `ok:integrations:dispatch` — status read + one-component set folded
 *     into a single discriminated channel (the `ok:worktree:dispatch`
 *     precedent), so the surface costs one slot, not two. Could not fold
 *     into the `ok:mcp-wiring:*` channels: those are the ONE-SHOT
 *     first-launch consent flow with sender-binding + `handled` idempotence
 *     (a persistent settings surface riding them would have to defeat both
 *     guards), and their confirm semantics are batched consent, not
 *     per-component install/uninstall with live status. New
 *     `ok:integrations:*` namespace, single member.
 *
 * Bumped from 78 to 79 for Settings → This project → AI tools (per-component
 * install/uninstall of OK's PROJECT-LOCAL footprint):
 *
 *   - `ok:project-integrations:dispatch` — the project-scoped sibling of
 *     `ok:integrations:dispatch`. Status read + one-component set folded into a
 *     single discriminated channel (same `ok:worktree:dispatch` precedent), so
 *     the surface costs one slot, not two. Could NOT fold into
 *     `ok:integrations:dispatch`: that channel is user-global (keyed on
 *     `osHomedir()`, no active project), whereas this one MUST resolve the
 *     sender window's project (webContents → ProjectContext) and its component
 *     set differs (per-editor PROJECT config files + a project skill; no
 *     PATH/Claude-Desktop rows). A shared channel would have to carry a
 *     scope discriminant AND branch every actor internally — two surfaces
 *     wearing one channel. Could not fold into `ok:onboarding:*` (the one-shot
 *     per-project consent dialog with sender-binding + mount-ack idempotence,
 *     batched consent rather than live per-component toggles). New
 *     `ok:project-integrations:*` namespace, single member. The typed-ipc
 *     migration remains the committed end state; scoped exception with the
 *     `ipc-channels.ts` header commitment updated in lock-step.
 *
 * Bumped from 79 to 81 for terminal-tab reload-survival (custom name + order
 * persisted in main so a ⌘R renderer reload restores them, not just the live
 * shells):
 *
 *   - `ok:pty:set-meta` — per-session tab metadata (custom name + sticky
 *     ordinal), a partial fire-and-forget update keyed by ptyId.
 *   - `ok:pty:set-order` — the window's tab display order (ptyIds in visual
 *     order), fire-and-forget.
 *     Two slots, not one: the `ok:pty:*` surface is "the smallest faithful PTY
 *     protocol" — one channel per operation (create/input/resize/kill/drain/
 *     list/adopt), NOT the dispatch-folding precedent — and these two payloads
 *     differ in shape AND cardinality (per-session partial meta vs per-window
 *     full ordering). Folding them into one discriminated channel would wear a
 *     single channel over two distinct operations against a namespace that
 *     deliberately keeps each PTY operation on its own channel.
 *
 * Bumped from 81 to 84 across a main merge for three independent single-member
 * additions:
 *
 *   - `ok:shell:reveal-external` — the terminal clickable-links out-of-project
 *     reveal: when a terminal link points at a file OUTSIDE the window's project,
 *     main pops a "reveal in Finder?" confirmation and reveals on confirm. A
 *     distinct trust boundary from `ok:shell:reveal-asset` — deliberately
 *     UNCONTAINED (the whole feature) but dialog-gated — so folding it onto the
 *     containment-checked asset reveal would wear one channel over two opposite
 *     security contracts.
 *   - `ok:terminal:set-dock-state` — the window's unified cross-kind tab order
 *     (terminal ptyIds + thread threadIds) + active key, persisted in main so a
 *     ⌘R renderer reload restores the interleaved arrangement. The `get`
 *     counterpart (`ok:terminal:dock-state`) already exists and gained the extra
 *     fields; the setter is its own channel (fire-and-forget write vs the read),
 *     the sibling of `ok:pty:set-order` for the mixed dock.
 *   - `ok:bug-report:dispatch` — the in-app "Report a bug" surface: builds the
 *     redacted diagnostic zip for the sender window's project via the CLI
 *     package's leveled `collectReportBundle`, in-process. Main owns it because
 *     the inputs are main-process state (window-manager project context,
 *     app version / packaged / update channel, the `~/.ok/bug-reports/` write);
 *     its upload + crash-ack operations widen this channel's payload rather than
 *     adding channels, so the whole surface costs one slot.
 *
 * The typed-ipc migration remains the committed end state, with the
 * `ipc-channels.ts` header updated in lock-step.
 *
 * Bumped from 84 to 86 for the two Cmd+K / native-menu command invokes:
 * `ok:mcp-wiring:reconfigure` (File → "Set up OpenKnowledge integrations…")
 * and `ok:spellcheck:toggle` (Edit → "Check spelling while typing"). Each
 * delegates to an existing main-side function; the typed-ipc migration remains
 * the committed end state, with the `ipc-channels.ts` header in lock-step.
 *
 * Bumped from 86 to 87 for File → "Open file…" (`ok:project:open-file-picker`):
 * the palette / Navigator entry point to the temporary single-file session,
 * delegating to the existing main-side picker + `openEphemeralFile` (the
 * desktop side of `ok <file>`). Single member; the typed-ipc migration remains
 * the committed end state, with the `ipc-channels.ts` header in lock-step.
 *
 * Bumped from 87 to 88 merging the Windows/Linux desktop port: the win/linux
 * renderer menubar (`ok:menu:dispatch`, the windows-linux-port renderer-menubar
 * decision): macOS keeps the native menu bar, but win/linux draw it in the
 * renderer, and every click routes back through main so menu semantics stay
 * single-sourced. Follows the `ok:sharing:dispatch` discriminated-union
 * precedent — query / menu-action relay / role / command all share ONE channel,
 * so the whole custom-menubar surface costs one slot forever. Could not fold
 * into an existing channel: `ok:menu-action` is an EventChannel (main→renderer
 * push, wrong direction) and no renderer→main menu surface exists. The typed-ipc
 * migration remains the committed end state, with the `ipc-channels.ts` header
 * updated in lock-step.
 *
 * Bumped from 88 to 90 by two independent additions that landed together.
 *
 * 89 is the React self-uninstall window (`ok:uninstall:dispatch`). The
 * uninstall screens were the last renderer→main surface still riding a private
 * `ok-desktop-uninstall://` URL scheme intercepted by `will-navigate`; moving
 * them onto real IPC retires that scheme. Follows the `ok:sharing:dispatch`
 * discriminated-union precedent — the screen pull plus every intent from all
 * four screens (picker, survey, progress, notices) share ONE slot, so porting
 * the remaining screens costs no further channels. Could not fold into an
 * existing channel: no renderer→main uninstall surface existed, and the
 * sender-validation rule (only a live uninstall window is answered) is specific
 * to this surface.
 *
 * 90 is the desktop background-throttling toggle
 * (`ok:editor:background-throttle`): the renderer reports its aggregate
 * unsynced-work state so main keeps the window's Chromium timers alive while
 * work is pending. Could not fold onto the sibling `ok:editor:*` snapshots:
 * those fire on active-target / view-menu changes and drive
 * `refreshApplicationMenu`, a different cadence and side effect than an
 * unsynced-work transition — a fold would rebuild the menu on every
 * keystroke-to-sync edge.
 *
 * Bumped from 90 to 92 (this and the interface-language push below) for the Slides (Slidev) presentation surface
 * (`ok:slides:dispatch`): one discriminated channel following the
 * `ok:sharing:dispatch` precedent — `status` detects whether a runnable
 * `slidev` resolves for the sender window's project, and `open` spawns the
 * deck; both share this one channel, and further verbs widen the payload
 * rather than adding a channel. Could not fold into an existing
 * channel: no channel carries a slidev/deck concept, and while it is
 * project-scoped like `ok:sharing:dispatch`, its result shape (`available` /
 * `source`) is unrelated to git-exclude posture — a fold would wear one channel
 * over two unrelated concerns.
 *
 * Bumped from 90 to 91 for the interface-language push
 * (`ok:locale:set-preference`): the renderer forwards the user's unresolved
 * language preference so main re-resolves it and rebuilds the native menu bar
 * live, which is the only way the menu tracks the picker without a restart.
 *
 * Folding onto `ok:theme:set-source` was the obvious move and is wrong. The two
 * share a contract almost exactly — same provider, same unresolved-`'system'`
 * one-way rule, same best-effort failure model — but they fire on independent
 * cadences, so one slot would mean setting `nativeTheme.themeSource` on every
 * language change and rebuilding the whole menu on every theme change. That is
 * the same cadence-coupling the 90th channel's narrative rejected, and the menu
 * rebuild is the more expensive of the two side effects. No other renderer→main
 * appearance surface exists: `ok:menu-action` and `ok:theme:applied` both push
 * the other direction.
 *
 * Bumped from 92 to 93 for the Cmd+C-on-image clipboard write
 * (`ok:clipboard:copy-image`): renderer sends a resolved img URL + alt
 * off the DOM, main fetches bytes (from disk when same-origin as the
 * asset serve; via network fetch otherwise) and calls
 * `clipboard.writeImage` — the only path that produces the 9-flavor
 * raster set macOS's pasteboard writer expands NSImage into, which is
 * what every rich receiver (Notes, Docs, Slack chat, Notion inline,
 * iMessage) reads. Chromium's Async Clipboard API in the renderer only
 * accepts one blob per MIME key, so the write cannot fold there.
 *
 * Could not fold onto `ok:clipboard:write-text` (the only sibling
 * clipboard channel): the two have incompatible payload shapes —
 * `write-text` takes a plain `string` and returns `undefined`, while
 * `copy-image` takes a `{src, alt}` params object and returns a
 * discriminated `CopyImageResult` with five failure reasons the
 * renderer branches on for the web-fallback path. Widening
 * `write-text`'s payload to carry both would erase the type safety
 * of both channels' callers.
 *
 * Bumped from 93 to 94 for the pop-out note window:
 *
 *   - `ok:window:open-note` — the doc-tab context menu and the command
 *     palette both ask main to pop a document into its own
 *     `--ok-mode=note` BrowserWindow. Main owns it because only main can
 *     create a window, resolve the sender's project from `windowsByPath`,
 *     and consult the note-window registry for focus-existing dedup.
 *
 *     Could not fold. `ok:menu:dispatch` is contractually the custom-drawn
 *     Windows/Linux menu bar and nothing else ("the menubar is one
 *     surface"), so an unrelated verb there would break that contract.
 *     `ok:project:open` is keyed by project path and opens a PROJECT
 *     window, a different lifecycle and a different registry. There is no
 *     existing window-opening channel with a compatible payload.
 *
 *     The same slot also carries a discriminated `dispatch-to-main` verb for
 *     conversation/comment actions started in a reduced note renderer. Main
 *     already owns the note→project-window association, so widening this
 *     window-routing channel preserves that boundary and adds no channel.
 *     One slot serves both renderer-originated open entry points and the
 *     handoff; the Window-menu entry point is main-originated and adds none.
 *
 * The typed-ipc migration remains the committed end state, with the
 * `ipc-channels.ts` header updated in lock-step.
 */
const REQUEST_CHANNEL_CAP = 94;

/**
 * Extract the body of an interface block by name. Returns the substring
 * between the opening `{` and its matching `}`. Brace-balanced — handles
 * nested object types in the channel signatures.
 */
function extractInterfaceBody(src: string, interfaceName: string): string {
  const re = new RegExp(`(^|\\n)export\\s+interface\\s+${interfaceName}\\s*\\{`);
  const match = re.exec(src);
  if (!match) {
    throw new Error(`ipc-channel-count-ratchet: ${interfaceName} interface not found`);
  }
  const open = match.index + match[0].length - 1;
  let depth = 1;
  let cursor = open + 1;
  while (cursor < src.length && depth > 0) {
    const ch = src[cursor];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, cursor);
    }
    cursor += 1;
  }
  throw new Error(`ipc-channel-count-ratchet: unbalanced braces in ${interfaceName}`);
}

/** Match `'ok:<surface>:<verb>': {` channel-key declarations. */
const CHANNEL_KEY_RE = /^\s*'(ok:[^']+)'\s*:\s*\{/gm;

function countChannelKeys(body: string): number {
  CHANNEL_KEY_RE.lastIndex = 0;
  let count = 0;
  while (CHANNEL_KEY_RE.exec(body) !== null) count += 1;
  return count;
}

describe('IPC channel count ratchet — RequestChannels', () => {
  test(`RequestChannels has at most ${REQUEST_CHANNEL_CAP} hand-rolled entries`, () => {
    const body = extractInterfaceBody(CHANNELS_SRC, 'RequestChannels');
    const count = countChannelKeys(body);
    if (count > REQUEST_CHANNEL_CAP) {
      throw new Error(
        [
          `IPC channel count exceeded committed cap of ${REQUEST_CHANNEL_CAP}.`,
          `Current count: ${count}.`,
          '',
          'The hand-rolled IPC discriminated union is past its scale-match trigger.',
          `Adding a ${REQUEST_CHANNEL_CAP + 1}th channel must coincide with the typed-ipc migration —`,
          'either land the migration spec first, or fold the new payload into an existing',
          'channel via additive optional fields (the `ok:theme:applied` precedent).',
          '',
          'If the migration has landed: update REQUEST_CHANNEL_CAP in this file AND the',
          'header comment in src/shared/ipc-channels.ts so the social commitment matches.',
        ].join('\n'),
      );
    }
    expect(count).toBeLessThanOrEqual(REQUEST_CHANNEL_CAP);
  });

  test('the channel-key regex actually matches entries (positive regression)', () => {
    // Mirror of `no-loosely-typed-webcontents-ipc.test.ts`'s mutation
    // check: prove the regex matches real entries before trusting the
    // count assertion. A future refactor that renames the interface or
    // changes the channel-key syntax must surface here, not silently
    // pass with `count === 0`.
    const body = extractInterfaceBody(CHANNELS_SRC, 'RequestChannels');
    const count = countChannelKeys(body);
    expect(count).toBeGreaterThan(0);
  });

  test('the source contains the scale-match commitment marker', () => {
    // The cap is enforced mechanically here AND documented socially in
    // the header comment. Drift between the two is itself a regression
    // — pin the marker so renaming the file's "scale-match trigger"
    // language fails this test, prompting an update to both surfaces.
    expect(CHANNELS_SRC).toMatch(/scale-match trigger|typed-ipc/i);
  });
});
