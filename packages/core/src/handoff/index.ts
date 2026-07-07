/**
 * Public surface of the Open-in-Agent handoff subsystem.
 *
 * Core is "shared, no React, no Node APIs" — this barrel re-exports only
 * pure string I/O and type shapes. Dispatch orchestration, UI, and the
 * `KNOWN_TARGETS` data constant live in `packages/app/src/lib/handoff/`.
 */

export { buildClaudeUrl } from './claude-url.ts';
export { buildCodexUrl } from './codex-url.ts';
export { buildCursorUrl } from './cursor-url.ts';
export {
  type AssembleHandoffPromptInput,
  assembleHandoffPrompt,
  type ComposeSelection,
  type CreateScenario,
  composeAskProjectPrompt,
  composeAskPrompt,
  composeCreatePrompt,
  composeEmptySpacePrompt,
  composeFilePrompt,
  composeFolderPrompt,
  composeSelectionPrompt,
  composeSkillPrompt,
  composeTerminalBareLaunchPrompt,
  OK_PROJECT_SKILL_POINTER,
  OK_TERMINAL_SURFACE_PREAMBLE,
  withSkillPointer,
} from './prompt-composer.ts';
export {
  buildClaudeLaunchCommand,
  buildCliLaunchArgString,
  buildCliLaunchCommand,
  shellSingleQuote,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
  type TerminalCliInfo,
} from './terminal-launch.ts';
export type {
  DocContext,
  HandoffFailureReason,
  HandoffOutcome,
  HandoffPayload,
  HandoffScope,
  HandoffTarget,
  InstallState,
  TargetData,
} from './types.ts';
export {
  assertNeverUrnIpcLookup,
  type IpcChannelReason,
  type IpcChannelWithUrn,
  lookupUrnInRegistry,
  URN_HTTP_ONLY,
  URN_IPC_REGISTRY,
  type UrnIpcLookup,
} from './urn-ipc-registry.ts';
