import type {
  AuthMethod,
  AvailableCommand,
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

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export const TRIAGED_SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
] as const;

export type PinSessionUpdateKinds = Expect<
  Equal<SessionUpdate['sessionUpdate'], (typeof TRIAGED_SESSION_UPDATE_KINDS)[number]>
>;

type AvailableCommandsUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: 'available_commands_update' }
>;
export type PinAvailableCommandsList = Expect<
  Equal<AvailableCommandsUpdate['availableCommands'], AvailableCommand[]>
>;
export type PinAvailableCommandName = Expect<Equal<AvailableCommand['name'], string>>;
export type PinAvailableCommandDescription = Expect<Equal<AvailableCommand['description'], string>>;
export type PinAvailableCommandInputHint = Expect<
  Equal<Extract<NonNullable<AvailableCommand['input']>, { hint: string }>['hint'], string>
>;

export type PinPermissionOptionKind = Expect<
  Equal<PermissionOption['kind'], 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'>
>;

export type PinPermissionOptionId = Expect<Equal<PermissionOption['optionId'], string>>;
export type PinPermissionOptionName = Expect<Equal<PermissionOption['name'], string>>;

export type PinPermissionOutcome = Expect<
  Equal<RequestPermissionResponse['outcome']['outcome'], 'selected' | 'cancelled'>
>;

export type PinAuthMethodKinds = Expect<
  Equal<Extract<AuthMethod, { type: string }>['type'], 'env_var' | 'terminal'>
>;

export type PinStopReason = Expect<
  Equal<StopReason, 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'>
>;

export type PinToolCallContentTypes = Expect<
  Equal<ToolCallContent['type'], 'content' | 'diff' | 'terminal'>
>;

type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;
export type PinUsageUsed = Expect<Equal<UsageUpdate['used'], number>>;
export type PinUsageSize = Expect<Equal<UsageUpdate['size'], number>>;

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
