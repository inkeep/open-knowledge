
export type HandoffTarget = 'claude-cowork' | 'claude-code' | 'codex' | 'cursor' | 'opencode';

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
