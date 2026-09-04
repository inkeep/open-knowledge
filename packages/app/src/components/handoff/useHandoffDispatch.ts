import {
  type AssembleHandoffPromptInput,
  assembleHandoffPrompt,
  type ComposeSelection,
  type CreateScenario,
  composeAskPrompt,
  composeCreatePrompt,
  composeEmptySpacePrompt,
  composeFilePrompt,
  composeFolderPrompt,
  composeSelectionPrompt,
  composeSkillPrompt,
  composeTerminalBareLaunchPrompt,
  composeThreadBareLaunchPrompt,
  type DocContext,
  type HandoffOutcome,
  type HandoffPayload,
  type HandoffScope,
  type HandoffTarget,
  OK_TERMINAL_SURFACE_PREAMBLE,
  OK_THREAD_SURFACE_PREAMBLE,
  type PromptTransport,
  type SkillScope,
  type TargetData,
  TERMINAL_CLIS,
  type TerminalCli,
  withSkillPointer,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { toast as sonnerToast } from 'sonner';
import { useConfigContext } from '@/lib/config-context';
import {
  type EnsureCoworkSkillOutcome,
  ensureCoworkSkillInstalledWithDefaults,
  reinstallCoworkSkill,
} from '@/lib/handoff/cowork-skill-install';
import { dispatchHandoff as defaultDispatchHandoff } from '@/lib/handoff/dispatch';
import { openExternal as defaultOpenExternal } from '@/lib/handoff/open-external';
import { KNOWN_TARGETS } from '@/lib/handoff/targets';
import {
  recordHandoff as defaultRecordHandoff,
  type HandoffHost,
  type HandoffStatsLine,
} from '@/lib/handoff/telemetry';
import { docNameToRelativePath, joinWorkspacePath, type Workspace } from '@/lib/workspace-paths';
import { requestAgentThreadLaunch } from './thread-launch-events';
import '@/lib/desktop-bridge-types';

interface SelectionContext {
  readonly relativePath: string;
  readonly instruction: string;
  readonly selectionMarkdown: string;
}

interface AskContext {
  readonly relativePath: string;
  readonly instruction: string;
}

type ComposeContext =
  | {
      readonly scope: 'doc';
      readonly docRelativePath: string;
      readonly selection?: ComposeSelection;
      readonly instruction: string;
      readonly mentions: readonly string[];
    }
  | {
      readonly scope: 'folder';
      readonly folderRelativePath: string;
      readonly instruction: string;
      readonly mentions: readonly string[];
    }
  | {
      readonly scope: 'project';
      readonly instruction: string;
      readonly mentions: readonly string[];
    };

export interface HandoffDispatchInput {
  readonly docContext: DocContext | null;
  readonly folderRelativePath?: string;
  readonly selection?: SelectionContext;
  readonly skill?: { readonly name: string; readonly scope: SkillScope };
  readonly ask?: AskContext;
  readonly compose?: ComposeContext;
  readonly createDescription?: string;
  readonly createScenario?: CreateScenario;
  readonly createMentions?: readonly string[];
  readonly instruction?: string;
  readonly projectDir: string;
  readonly docPath: string;
}

export function buildHandoffInput(args: {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  if (!args.docName || !args.workspace) return null;
  const relativePath = docNameToRelativePath(args.docName);
  const { contentDir, pathSeparator } = args.workspace;
  return {
    docContext: { relativePath },
    projectDir: contentDir,
    docPath: joinWorkspacePath(contentDir, relativePath, pathSeparator),
  };
}

export function buildProjectScopedHandoffInput(args: {
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  return {
    docContext: null,
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

export function buildCreateHandoffInput(args: {
  readonly workspace: Workspace | null;
  readonly description: string;
  readonly scenario: CreateScenario;
  readonly mentions: readonly string[];
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  return {
    docContext: null,
    createDescription: args.description,
    createScenario: args.scenario,
    createMentions: args.mentions,
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

export function openInstallUrl(target: TargetData): Promise<void> {
  return defaultOpenExternal(target.installUrl).then(() => undefined);
}

export function buildFolderHandoffInput(args: {
  readonly folderRelativePath: string;
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  if (!args.folderRelativePath) return null;
  return {
    docContext: null,
    folderRelativePath: args.folderRelativePath,
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

export function buildSelectionHandoffInput(args: {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
  readonly instruction: string;
  readonly selectionMarkdown: string;
}): HandoffDispatchInput | null {
  if (!args.docName || !args.workspace) return null;
  if (!args.selectionMarkdown) return null;
  const relativePath = docNameToRelativePath(args.docName);
  const { contentDir, pathSeparator } = args.workspace;
  return {
    docContext: null,
    selection: {
      relativePath,
      instruction: args.instruction,
      selectionMarkdown: args.selectionMarkdown,
    },
    projectDir: contentDir,
    docPath: joinWorkspacePath(contentDir, relativePath, pathSeparator),
  };
}

export function buildSkillHandoffInput(args: {
  readonly skillName: string;
  readonly scope: SkillScope;
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir || !args.skillName) return null;
  return {
    docContext: null,
    skill: { name: args.skillName, scope: args.scope },
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

export function buildAskHandoffInput(args: {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
  readonly instruction: string;
}): HandoffDispatchInput | null {
  if (!args.docName || !args.workspace) return null;
  const relativePath = docNameToRelativePath(args.docName);
  const { contentDir, pathSeparator } = args.workspace;
  return {
    docContext: null,
    ask: {
      relativePath,
      instruction: args.instruction,
    },
    projectDir: contentDir,
    docPath: joinWorkspacePath(contentDir, relativePath, pathSeparator),
  };
}

export function buildComposerHandoffInput(args: {
  readonly docName: string | null;
  readonly docRelativePath?: string;
  readonly folderRelativePath?: string;
  readonly workspace: Workspace | null;
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly selection?: ComposeSelection;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  const { contentDir, pathSeparator } = args.workspace;
  if (args.docName) {
    const relativePath = args.docRelativePath ?? docNameToRelativePath(args.docName);
    const base = {
      scope: 'doc' as const,
      docRelativePath: relativePath,
      instruction: args.instruction,
      mentions: args.mentions,
    };
    const compose: ComposeContext =
      args.selection !== undefined ? { ...base, selection: args.selection } : base;
    return {
      docContext: null,
      compose,
      projectDir: contentDir,
      docPath: joinWorkspacePath(contentDir, relativePath, pathSeparator),
    };
  }
  if (args.folderRelativePath) {
    return {
      docContext: null,
      compose: {
        scope: 'folder',
        folderRelativePath: args.folderRelativePath,
        instruction: args.instruction,
        mentions: args.mentions,
      },
      projectDir: contentDir,
      docPath: '',
    };
  }
  return {
    docContext: null,
    compose: {
      scope: 'project',
      instruction: args.instruction,
      mentions: args.mentions,
    },
    projectDir: contentDir,
    docPath: '',
  };
}

export function buildSelectionOrDocHandoffInput(args: {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
  readonly instruction: string;
  readonly selectionMarkdown: string;
}): HandoffDispatchInput | null {
  return buildSelectionHandoffInput(args) ?? buildHandoffInput(args);
}

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastSurface {
  success(message: string): void;
  error(message: string, options?: { action?: ToastAction }): void;
}

export interface HandoffDispatchDeps {
  readonly dispatchHandoff: (payload: HandoffPayload) => Promise<HandoffOutcome>;
  readonly recordHandoff: (line: HandoffStatsLine) => Promise<void>;
  readonly toast: ToastSurface;
  readonly now: () => Date;
  readonly isElectronHost: () => boolean;
  readonly getDisplayName: (target: HandoffTarget) => string;
  readonly ensureCoworkSkillInstalled: () => Promise<EnsureCoworkSkillOutcome>;
  readonly autoOpen: boolean;
}

export const MAX_DISPATCH_ATTEMPTS = 3;

export function successToastMessage(displayName: string): string {
  return `Opened in ${displayName}.`;
}

export function errorToastMessage(displayName: string, attempt = 1): string {
  if (attempt >= MAX_DISPATCH_ATTEMPTS) {
    return t`Couldn't reach ${displayName} — please try again later.`;
  }
  if (attempt === MAX_DISPATCH_ATTEMPTS - 1) {
    return t`Still couldn't reach ${displayName} — try one more time?`;
  }
  return t`Couldn't reach ${displayName} — try again?`;
}

export function retryActionLabel(attempt: number): string | null {
  if (attempt >= MAX_DISPATCH_ATTEMPTS) return null;
  return attempt === MAX_DISPATCH_ATTEMPTS - 1 ? t`Try one more time` : t`Retry`;
}

function buildStatsLine(
  target: HandoffTarget,
  outcome: HandoffOutcome,
  host: HandoffHost,
  ts: string,
  scope: HandoffScope | undefined,
): HandoffStatsLine {
  const scopeField = scope === undefined ? {} : { scope };
  if (outcome.ok) {
    return { target, host, outcome: 'ok', ts, ...scopeField };
  }
  return { target, host, outcome: 'error', ts, reason: outcome.reason, ...scopeField };
}

function composeContextToAssembleInput(
  compose: ComposeContext,
  target: HandoffTarget,
  autoOpen: boolean,
  transport: PromptTransport,
): AssembleHandoffPromptInput {
  if (compose.scope === 'doc') {
    const base = {
      scope: 'doc' as const,
      docRelativePath: compose.docRelativePath,
      instruction: compose.instruction,
      mentions: compose.mentions,
      target,
      autoOpen,
      transport,
    };
    return compose.selection !== undefined ? { ...base, selection: compose.selection } : base;
  }
  if (compose.scope === 'folder') {
    return {
      scope: 'folder',
      folderRelativePath: compose.folderRelativePath,
      instruction: compose.instruction,
      mentions: compose.mentions,
      target,
      autoOpen,
      transport,
    };
  }
  return {
    scope: 'project',
    instruction: compose.instruction,
    mentions: compose.mentions,
    target,
    autoOpen,
    transport,
  };
}

export function selectScopedPrompt(
  input: HandoffDispatchInput,
  target: HandoffTarget,
  autoOpen: boolean,
  transport: PromptTransport,
): string {
  if (input.compose) {
    return assembleHandoffPrompt(
      composeContextToAssembleInput(input.compose, target, autoOpen, transport),
    );
  }
  if (input.selection) {
    return composeSelectionPrompt({ ...input.selection, target, transport });
  }
  if (input.skill) {
    return composeSkillPrompt(input.skill.name, input.skill.scope, autoOpen);
  }
  if (input.ask) {
    return composeAskPrompt(
      input.ask.relativePath,
      input.ask.instruction,
      autoOpen,
      target,
      transport,
    );
  }
  const directive =
    input.docContext !== null
      ? composeFilePrompt(input.docContext.relativePath, autoOpen, input.instruction, transport)
      : input.folderRelativePath
        ? composeFolderPrompt(input.folderRelativePath, autoOpen, input.instruction, transport)
        : input.createDescription !== undefined
          ? composeCreatePrompt(
              input.createDescription,
              autoOpen,
              input.createScenario ?? 'new-project',
              input.createMentions ?? [],
              transport,
            )
          : composeEmptySpacePrompt(autoOpen, input.instruction, transport);
  return withSkillPointer(directive);
}

export function composeTerminalLaunchPrompt(input: HandoffDispatchInput, cli: TerminalCli): string {
  const hasInstruction = typeof input.instruction === 'string' && input.instruction.trim() !== '';
  if (
    input.compose !== undefined ||
    input.createDescription !== undefined ||
    input.skill !== undefined ||
    hasInstruction
  ) {
    return `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, TERMINAL_CLIS[cli].handoffTarget, false, 'terminal')}`;
  }
  return composeTerminalBareLaunchPrompt(input.docContext?.relativePath ?? null);
}

function composeThreadLaunchPrompt(input: HandoffDispatchInput): string {
  const hasInstruction = typeof input.instruction === 'string' && input.instruction.trim() !== '';
  if (
    input.compose !== undefined ||
    input.createDescription !== undefined ||
    input.skill !== undefined ||
    hasInstruction
  ) {
    return `${OK_THREAD_SURFACE_PREAMBLE} ${selectScopedPrompt(input, 'claude-code', false, 'terminal')}`;
  }
  return composeThreadBareLaunchPrompt(input.docContext?.relativePath ?? null);
}

function docNameFromInput(input: HandoffDispatchInput): string | null {
  const rel = input.docContext?.relativePath;
  if (typeof rel !== 'string' || rel === '') return null;
  return rel.replace(/\.(md|mdx)$/, '');
}

export function threadTitleHintFromInput(input: HandoffDispatchInput): string | null {
  const candidates = [
    input.compose?.instruction,
    input.selection?.instruction,
    input.ask?.instruction,
    input.createDescription,
    input.instruction,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

export function startAgentThreadForInput(
  input: HandoffDispatchInput,
  opts?: {
    agent?: { source: 'registry' | 'custom'; id: string };
  },
): void {
  requestAgentThreadLaunch({
    agentSource: opts?.agent?.source ?? 'registry',
    agentId: opts?.agent?.id ?? '',
    prompt: composeThreadLaunchPrompt(input),
    docName: docNameFromInput(input),
    titleHint: threadTitleHintFromInput(input),
  });
}

export async function runHandoffDispatch(
  target: HandoffTarget,
  input: HandoffDispatchInput,
  deps: HandoffDispatchDeps,
  attempt = 1,
): Promise<HandoffOutcome> {
  if (target === 'claude-cowork' && attempt === 1) {
    let installOutcome: EnsureCoworkSkillOutcome;
    try {
      installOutcome = await deps.ensureCoworkSkillInstalled();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.toast.error(t`Couldn't install OpenKnowledge skill — ${message}`);
      return { ok: false, reason: 'dispatch-error', detail: `install-error: ${message}` };
    }
    if (installOutcome.kind === 'installed-now') {
      deps.toast.success(
        t`OpenKnowledge skill saved. Upload it in Claude Desktop, then click Cowork again.`,
      );
      return { ok: true };
    }
    if (installOutcome.kind === 'install-failed') {
      const message = installOutcome.message ?? installOutcome.reason;
      deps.toast.error(t`Couldn't install OpenKnowledge skill — ${message}`);
      return { ok: false, reason: 'dispatch-error', detail: `install-failed: ${message}` };
    }
  }

  const payload: HandoffPayload = {
    target,
    projectDir: input.projectDir,
    docPath: input.docPath,
    prompt: selectScopedPrompt(input, target, deps.autoOpen, 'url'),
  };

  const outcome = await deps.dispatchHandoff(payload);

  const host: HandoffHost = deps.isElectronHost() ? 'electron' : 'web';
  const ts = deps.now().toISOString();
  const compose = input.compose;
  const shipsSelection =
    input.selection != null || (compose?.scope === 'doc' && compose.selection !== undefined);
  const line = buildStatsLine(target, outcome, host, ts, shipsSelection ? 'selection' : undefined);
  await deps.recordHandoff(line);

  const displayName = deps.getDisplayName(target);
  if (outcome.ok) {
    deps.toast.success(successToastMessage(displayName));
  } else {
    const label = retryActionLabel(attempt);
    const message = errorToastMessage(displayName, attempt);
    if (label !== null) {
      deps.toast.error(message, {
        action: {
          label,
          onClick: () => {
            void runHandoffDispatch(target, input, deps, attempt + 1);
          },
        },
      });
    } else {
      deps.toast.error(message);
    }
  }

  return outcome;
}

export function getDisplayNameDefault(target: HandoffTarget): string {
  const entry = KNOWN_TARGETS.find((t) => t.id === target);
  return entry?.displayName ?? target;
}

export function isElectronHostDefault(
  windowLike: { okDesktop?: unknown } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): boolean {
  return windowLike?.okDesktop != null;
}

export function defaultHandoffDispatchDeps(): HandoffDispatchDeps {
  return {
    dispatchHandoff: defaultDispatchHandoff,
    recordHandoff: defaultRecordHandoff,
    toast: {
      success: (message: string) => {
        sonnerToast.success(message);
      },
      error: (message: string, options?: { action?: ToastAction }) => {
        sonnerToast.error(message, options ? { action: options.action } : undefined);
      },
    },
    now: () => new Date(),
    isElectronHost: () => isElectronHostDefault(),
    getDisplayName: getDisplayNameDefault,
    ensureCoworkSkillInstalled: ensureCoworkSkillInstalledWithDefaults,
    autoOpen: true,
  };
}

interface UseHandoffDispatchResult {
  dispatch: (target: HandoffTarget, input: HandoffDispatchInput) => Promise<HandoffOutcome>;
  reinstallCoworkSkill: () => Promise<EnsureCoworkSkillOutcome>;
}

export function useHandoffDispatch(): UseHandoffDispatchResult {
  const { merged } = useConfigContext();
  const autoOpen = merged?.appearance?.preview?.autoOpen ?? true;
  return {
    dispatch: (target, input) =>
      runHandoffDispatch(target, input, { ...defaultHandoffDispatchDeps(), autoOpen }),
    reinstallCoworkSkill,
  };
}
