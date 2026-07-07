/**
 * Shared types for the Open-in-Agent handoff subsystem. No React, no Node —
 * pure type surface consumable from Electron main, renderer, and server.
 */

// `opencode` is a TERMINAL-ONLY target: it has no URL scheme / GUI app, so it
// is carved out of the deep-link dispatch path (no `RECIPES` recipe, no
// `dispatch.ts` URL case, excluded from `VISIBLE_TARGETS`). It is a member of
// the union only so it can reuse the shared brand-icon + display-name metadata
// that the terminal-CLI launch rows render. Reached exclusively via
// `requestTerminalLaunch` / `TERMINAL_CLIS`, never `dispatchHandoff`.
export type HandoffTarget = 'claude-cowork' | 'claude-code' | 'codex' | 'cursor' | 'opencode';

/**
 * Data carried from the UI to the URL builder. Minimal by construction: only
 * path + prompt. The target agent grounds via the OpenKnowledge MCP server
 * (precedent #25 writer-ID taxonomy); the
 * URL never carries file content / a `file=` attach param — only a short
 * directive `prompt` and the project / folder path.
 *
 * The URL builders thread `prompt` (when non-empty) into the per-target
 * prompt query param (`q=` / `prompt=` / `text=`) regardless of scope. The
 * caller (`runHandoffDispatch`) composes the right scope-specific prompt —
 * file directive, folder directive, or project directive — and the builder
 * just encodes it. An empty `prompt` is a defensive fallback that drops the
 * query param.
 *
 * The renderer helpers `buildHandoffInput` (file scope),
 * `buildFolderHandoffInput` (folder scope), and `buildProjectScopedHandoffInput`
 * (project scope) wrap the sentinel construction so call sites never pass
 * `''` directly.
 */
export interface HandoffPayload {
  readonly target: HandoffTarget;
  /** Absolute path to the OK project root (OS-native separator) for file
   *  scope; the folder absolute path for folder scope; the project root for
   *  project scope. Threaded into the URL as `folder=` (Claude family) /
   *  `path=` (Codex) / `workspace=<basename>` (Cursor). */
  readonly projectDir: string;
  /** Absolute path to the current doc (OS-native separator), or `''` when no
   *  doc is selected (folder / project scope). Not threaded into the URL by
   *  the per-target builders — they emit the same shape for any `docPath`
   *  value because the prompt scope is determined by `prompt`. Carried for
   *  callers / telemetry that need the field after dispatch. */
  readonly docPath: string;
  /** OK-composed scope-specific prompt, threaded into the URL via the
   *  per-target prompt query param. File / folder / project prompts are short
   *  directives (~100 chars); the selection prompt can inline the selected
   *  passage and runs larger, bounded only by the enforced 4096-char
   *  post-encoding URL cap (`composeSelectionPrompt` chooses inline vs locus
   *  transport against that budget). `''` is honored defensively (URL builders
   *  skip the prompt query param) but no production caller emits it. */
  readonly prompt: string;
}

/**
 * **DRIFT WARNING — this union is mirrored inline in four places** for
 * IPC-channel / bridge-contract isolation (the bridge surfaces cannot import
 * from `core/handoff/` without pulling the whole handoff package into the
 * Electron preload bundle). TypeScript catches drift at call-site boundaries
 * but not at the definitions. Keep these in lockstep:
 *
 *   1. `packages/desktop/src/shared/ipc-channels.ts` — `HandoffStatsLine.reason`
 *   2. `packages/desktop/src/shared/bridge-contract.ts` — `OkDesktopBridge.shell.recordHandoff` param
 *   3. `packages/core/src/desktop-bridge.ts` — canonical `OkDesktopBridge.shell.recordHandoff` param
 *   4. `packages/app/src/lib/desktop-bridge-types.ts` — renderer-side augmentation
 */
export type HandoffFailureReason =
  | 'not-installed'
  | 'scheme-blocked'
  | 'web-endpoint-error'
  | 'invalid-payload'
  | 'dispatch-error'
  | 'web-host-cursor-unsupported';

/**
 * Scope discriminator recorded on a handoff telemetry line. Present only on a
 * selection-scoped dispatch; the file / folder / project scopes omit the
 * field, so an absent `scope` reads as a non-selection handoff.
 *
 * **DRIFT WARNING** — like `HandoffFailureReason` above, this is mirrored
 * inline as an optional `scope?` field in the same four IPC-channel /
 * bridge-contract sites enumerated above (they cannot import from
 * `core/handoff/`). Keep in lockstep.
 */
export type HandoffScope = 'selection';

/**
 * Outcome of a dispatch attempt. `ok:true` does NOT guarantee the target app
 * actually launched — `shell.openExternal` resolves on handoff success, not
 * on target-app-visible-to-user. Matches Promise semantics of the underlying
 * Electron API.
 */
export type HandoffOutcome =
  | { ok: true; degradedFeatures?: ReadonlyArray<'prompt' | 'folder' | 'file'> }
  | { ok: false; reason: HandoffFailureReason; detail?: string };

/**
 * Install-detection result. `installed: null` means we haven't checked yet
 * (initial state before the first probe completes). Consumers render as
 * disabled while null.
 */
export interface InstallState {
  readonly installed: boolean | null;
  readonly displayName?: string;
  /** ms since epoch; used by the per-target 10s refresh throttle. */
  readonly lastChecked?: number;
}

export interface DocContext {
  /**
   * Path relative to the OK content dir, forward-slash normalized.
   */
  readonly relativePath: string;
}

/**
 * Static metadata for each handoff target. Pure data (no functions) —
 * dispatch is a hand-rolled switch in app-layer `dispatch.ts`.
 * `KNOWN_TARGETS: ReadonlyArray<TargetData>` lives in
 * `packages/app/src/lib/handoff/targets.ts`; the type stays here so both
 * main and renderer agree on shape.
 */
export interface TargetData {
  /** Stable ID — dropdown key, test-matrix key. Kebab-case. */
  readonly id: HandoffTarget;
  /** User-facing display name — fills "Open in <displayName>". */
  readonly displayName: string;
  /**
   * App-brand name shown in disabled-state copy ("Requires <appBrandName>").
   * Distinct from `displayName` because Cowork and Code are tabs of a single
   * app ("Claude Desktop") — the disabled message points at the installable
   * app, not the tab. Falls back to `displayName` when omitted.
   */
  readonly appBrandName?: string;
  /**
   * URL scheme(s) to probe for install detection. Cowork + Code both list
   * `['claude:']`; install detection dedupes via
   * `new Set(KNOWN_TARGETS.flatMap(t => t.schemes))`.
   */
  readonly schemes: ReadonlyArray<string>;
  /** Download / install page URL — shown in the disabled tooltip. */
  readonly installUrl: string;
  /**
   * One-line user-facing description, shown beneath `displayName` on
   * card-shaped surfaces (post-init `AgentHandoffGrid`). Helps users pick
   * between editors with similar names (Claude Cowork vs Claude).
   * Omitted on dropdown/menu surfaces where vertical space is constrained.
   */
  readonly tagline?: string;
}
