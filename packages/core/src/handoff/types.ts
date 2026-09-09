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
 * The precedent #60 invariant ("agent grounds via OK MCP, not native attach") holds by construction:
 * the payload carries only a short directive `prompt` and the project / folder path, never file
 * content or a `file=` attach param.
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
