export type HandoffTarget =
  | 'claude-cowork'
  | 'claude-code'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'opencode'
  | 'pi'
  | 'antigravity'
  | 'openclaw'
  | 'hermes';

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
  readonly projectDir: string;
  readonly docPath: string;
  readonly prompt: string;
}

export type HandoffFailureReason =
  | 'not-installed'
  | 'scheme-blocked'
  | 'web-endpoint-error'
  | 'invalid-payload'
  | 'dispatch-error'
  | 'web-host-cursor-unsupported';

export type HandoffScope = 'selection';

export type HandoffOutcome =
  | { ok: true; degradedFeatures?: ReadonlyArray<'prompt' | 'folder' | 'file'> }
  | { ok: false; reason: HandoffFailureReason; detail?: string };

export interface InstallState {
  readonly installed: boolean | null;
  readonly displayName?: string;
  readonly lastChecked?: number;
}

export interface DocContext {
  readonly relativePath: string;
}

export interface TargetData {
  readonly id: HandoffTarget;
  readonly displayName: string;
  readonly appBrandName?: string;
  readonly schemes: ReadonlyArray<string>;
  readonly installUrl: string;
  readonly tagline?: string;
}
