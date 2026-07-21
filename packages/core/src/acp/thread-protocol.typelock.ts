/**
 * Compile-time pins on the `@agentclientprotocol/sdk` unions and shapes this
 * codebase attaches BEHAVIOR to. Nothing here runs — each alias fails
 * `tsc --noEmit` when an SDK upgrade changes the pinned contract, turning
 * silent semantic drift (a new union member falling through a `default:`
 * branch, a reshaped field read through a cast) into a loud, located build
 * error on the upgrade PR. When a pin fires: review the dependents named on
 * it, adapt them if needed, then update the pin to the new shape.
 */

import type {
  ClientCapabilities,
  CreateTerminalRequest,
  EnvVariable,
  PermissionOption,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  TerminalExitStatus,
  TerminalOutputResponse,
  ToolCallContent,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

/** Invariant type equality — strict enough to catch `any` and member drift. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Dependents: the thread model's `applyUpdate` switch routes on this
// discriminant with a permissive `default:` (forward compatibility), so a
// NEW member never breaks the build — it silently renders as nothing. This
// pin makes the addition loud so someone decides how it should render.
export type PinSessionUpdateKinds = Expect<
  Equal<
    SessionUpdate['sessionUpdate'],
    | 'user_message_chunk'
    | 'agent_message_chunk'
    | 'agent_thought_chunk'
    | 'tool_call'
    | 'tool_call_update'
    | 'plan'
    | 'plan_update'
    | 'plan_removed'
    | 'available_commands_update'
    | 'current_mode_update'
    | 'config_option_update'
    | 'session_info_update'
    | 'usage_update'
  >
>;

// Dependents: `resolvePermissionOutcome` classifies by kind PREFIX
// (`startsWith('reject')` → denied, everything else → approved), and the
// permission card renders its own Deny only when no reject-kind option
// exists. A fifth kind outside these four would silently classify as an
// approval.
export type PinPermissionOptionKind = Expect<
  Equal<PermissionOption['kind'], 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'>
>;

// Dependents: `resolvePermissionOutcome` looks the chosen option up by
// `optionId` (an unmatched id classifies as dismissed, so this going
// optional would dismiss every resolution) and renders `name` in the
// summary; the card keys its buttons by `optionId`.
export type PinPermissionOptionId = Expect<Equal<PermissionOption['optionId'], string>>;
export type PinPermissionOptionName = Expect<Equal<PermissionOption['name'], string>>;

// Dependents: the explicit Deny button, permission timeouts, and turn-cancel
// all express refusal as `cancelled` — the protocol's only non-selection
// outcome today. If ACP grows a first-class per-tool deny, those mappings
// should adopt it.
export type PinPermissionOutcome = Expect<
  Equal<RequestPermissionResponse['outcome']['outcome'], 'selected' | 'cancelled'>
>;

// Dependents: the server maps a user-cancelled turn to `cancelled` and the
// UI treats every stop reason as a plain turn end.
export type PinStopReason = Expect<
  Equal<StopReason, 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'>
>;

// Dependents: `mergeToolContent` dispatches on these block types ('diff' →
// diff rows, 'terminal' → terminal ids, 'content' → text); a new type falls
// into the plain-text fallback unnoticed.
export type PinToolCallContentTypes = Expect<
  Equal<ToolCallContent['type'], 'content' | 'diff' | 'terminal'>
>;

// Dependents: the model's `usage_update` fold reads `used`/`size` at the TOP
// level of the update, and the composer footer renders them. (A nested-key
// misread of this exact shape once shipped; the pin keeps it from
// re-forming.)
type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;
export type PinUsageUsed = Expect<Equal<UsageUpdate['used'], number>>;
export type PinUsageSize = Expect<Equal<UsageUpdate['size'], number>>;

// Dependents: the thread manager advertises `terminal: true`, and
// `AcpTerminalSet` consumes exactly these request fields / produces exactly
// these response shapes.
export type PinTerminalCapability = Expect<
  Equal<ClientCapabilities['terminal'], boolean | undefined>
>;
export type PinCreateTerminalCommand = Expect<Equal<CreateTerminalRequest['command'], string>>;
export type PinCreateTerminalArgs = Expect<
  Equal<CreateTerminalRequest['args'], string[] | undefined>
>;
export type PinCreateTerminalEnv = Expect<
  Equal<CreateTerminalRequest['env'], EnvVariable[] | undefined>
>;
export type PinEnvVariableName = Expect<Equal<EnvVariable['name'], string>>;
export type PinEnvVariableValue = Expect<Equal<EnvVariable['value'], string>>;
export type PinCreateTerminalCwd = Expect<
  Equal<CreateTerminalRequest['cwd'], string | null | undefined>
>;
export type PinCreateTerminalOutputByteLimit = Expect<
  Equal<CreateTerminalRequest['outputByteLimit'], number | null | undefined>
>;
export type PinTerminalOutputText = Expect<Equal<TerminalOutputResponse['output'], string>>;
export type PinTerminalOutputTruncated = Expect<
  Equal<TerminalOutputResponse['truncated'], boolean>
>;
export type PinTerminalOutputExitStatus = Expect<
  Equal<TerminalOutputResponse['exitStatus'], TerminalExitStatus | null | undefined>
>;
export type PinTerminalExitCode = Expect<
  Equal<TerminalExitStatus['exitCode'], number | null | undefined>
>;
export type PinTerminalExitSignal = Expect<
  Equal<TerminalExitStatus['signal'], string | null | undefined>
>;
export type PinWaitForExitCode = Expect<
  Equal<WaitForTerminalExitResponse['exitCode'], number | null | undefined>
>;
export type PinWaitForExitSignal = Expect<
  Equal<WaitForTerminalExitResponse['signal'], string | null | undefined>
>;
