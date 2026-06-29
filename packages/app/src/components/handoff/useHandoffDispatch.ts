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
  type DocContext,
  type HandoffOutcome,
  type HandoffPayload,
  type HandoffScope,
  type HandoffTarget,
  OK_TERMINAL_SURFACE_PREAMBLE,
  type SkillScope,
  type TargetData,
  TERMINAL_CLIS,
  type TerminalCli,
  withSkillPointer,
} from '@inkeep/open-knowledge-core';
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
      /** Active doc's path relative to the OK content dir, forward-slash
       *  normalized with the `.md` suffix. Sanitized inside the assembler. */
      readonly docRelativePath: string;
      /** The active doc's selected passage transport (inline / lines / anchor).
       *  Omitted when there is no selection at submit. */
      readonly selection?: ComposeSelection;
      readonly instruction: string;
      readonly mentions: readonly string[];
    }
  | {
      readonly scope: 'folder';
      /** Active folder's path relative to the OK content dir, forward-slash
       *  normalized with no trailing slash. Sanitized inside the assembler. */
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
  /** Folder's path relative to `workspace.contentDir`, forward-slash
   *  normalized, no trailing slash. Set by `buildFolderHandoffInput`; absent
   *  for file + project scope. The dispatch hook reads this to select between
   *  the folder and empty-space prompt templates when `docContext` is null. */
  readonly folderRelativePath?: string;
  /** Selection-scope payload — the markdown-serialized passage plus the doc
   *  it lives in and the user's instruction. Set for selection scope only;
   *  absent for file / folder / project scope. */
  readonly selection?: SelectionContext;
  /** Skill-scope payload — the skill's identity + which store it lives in.
   *  Set by `buildSkillHandoffInput`; absent for every other scope. Routes
   *  `selectScopedPrompt` to `composeSkillPrompt` (author-with-AI: hand the
   *  draft to an agent to write via the `open-knowledge-write-skill` skill). */
  readonly skill?: { readonly name: string; readonly scope: SkillScope };
  /** Ask-scope payload — the active doc's relative path plus the user's typed
   *  instruction, with NO selection. Set for the bottom "Ask AI" composer
   *  only; absent for every other scope. A dedicated discriminator rather than
   *  a reuse of `docContext`: the no-selection file path composes
   *  `composeFilePrompt`, which carries no instruction, so routing an ask
   *  dispatch through it would silently drop the user's typed text. */
  readonly ask?: AskContext;
  /** Compose-scope payload — the unified "Ask AI" composer: scope
   *  (doc vs project), the user's instruction, ordered explicit `@path`
   *  mentions, and (doc scope) an optional selected passage. Set by
   *  `buildComposerHandoffInput`; absent for every other scope. When present,
   *  `selectScopedPrompt` routes through the holistic `assembleHandoffPrompt`
   *  (NOT a per-composer fit), so instruction + selection + N mentions are
   *  budgeted to the per-target URL in one pass. Checked first in the
   *  precedence chain — it is the only scope that carries explicit mentions. */
  readonly compose?: ComposeContext;
  /** Create-scope brief — the user's free-form description of the knowledge
   *  base they want to scaffold, typed into the empty-state "Create with
   *  <agent>" composer. Set by `buildCreateHandoffInput`; absent for every
   *  other scope. When present (even as the empty string), `selectScopedPrompt`
   *  composes via `composeCreatePrompt` instead of the bare project directive. */
  readonly createDescription?: string;
  /** Create-scope surface — `new-project` (onboarding) vs `existing-repo`
   *  (post-init). Selects the `composeCreatePrompt` framing so an existing
   *  project isn't described as a brand-new one. Set alongside
   *  `createDescription`; defaults to `new-project` if absent. */
  readonly createScenario?: CreateScenario;
  /** Create-scope explicit `@path` mentions — the doc/file chips the user
   *  inserted in the create composer. Sanitized and budgeted (never trimmed)
   *  by `composeCreatePrompt`. Set alongside `createDescription`. */
  readonly createMentions?: readonly string[];
  /** Optional free-text instruction the user typed in the toolbar "Open with
   *  AI" popover. Orthogonal to scope: it applies to file / folder / project
   *  (empty-space) dispatch — the three directive composers append it as a
   *  quoted `Instruction:` block. Unset for the right-click submenus and
   *  CommandPalette (which dispatch instantly with no prompt box), and for
   *  selection / create scope (which carry their own free-text via
   *  `selection.instruction` / `createDescription`). Set at the popover call
   *  site, not by the shared `build*HandoffInput` helpers. */
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
  /** Workspace-relative folder path, forward-slash normalized, no trailing
   *  slash. When set and `docName` is null, selects folder scope. */
  readonly folderRelativePath?: string;
  readonly workspace: Workspace | null;
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly selection?: ComposeSelection;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  const { contentDir, pathSeparator } = args.workspace;
  if (args.docName) {
    const relativePath = docNameToRelativePath(args.docName);
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
    return `Couldn't reach ${displayName} — please try again later.`;
  }
  if (attempt === MAX_DISPATCH_ATTEMPTS - 1) {
    return `Still couldn't reach ${displayName} — try one more time?`;
  }
  return `Couldn't reach ${displayName} — try again?`;
}

export function retryActionLabel(attempt: number): string | null {
  if (attempt >= MAX_DISPATCH_ATTEMPTS) return null;
  return attempt === MAX_DISPATCH_ATTEMPTS - 1 ? 'Try one more time' : 'Retry';
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
): AssembleHandoffPromptInput {
  if (compose.scope === 'doc') {
    const base = {
      scope: 'doc' as const,
      docRelativePath: compose.docRelativePath,
      instruction: compose.instruction,
      mentions: compose.mentions,
      target,
      autoOpen,
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
    };
  }
  return {
    scope: 'project',
    instruction: compose.instruction,
    mentions: compose.mentions,
    target,
    autoOpen,
  };
}

export function selectScopedPrompt(
  input: HandoffDispatchInput,
  target: HandoffTarget,
  autoOpen: boolean,
): string {
  if (input.compose) {
    return assembleHandoffPrompt(composeContextToAssembleInput(input.compose, target, autoOpen));
  }
  if (input.selection) {
    return composeSelectionPrompt({ ...input.selection, target });
  }
  if (input.skill) {
    return composeSkillPrompt(input.skill.name, input.skill.scope, autoOpen);
  }
  if (input.ask) {
    return composeAskPrompt(input.ask.relativePath, input.ask.instruction, autoOpen, target);
  }
  const directive =
    input.docContext !== null
      ? composeFilePrompt(input.docContext.relativePath, autoOpen, input.instruction)
      : input.folderRelativePath
        ? composeFolderPrompt(input.folderRelativePath, autoOpen, input.instruction)
        : input.createDescription !== undefined
          ? composeCreatePrompt(
              input.createDescription,
              autoOpen,
              input.createScenario ?? 'new-project',
              input.createMentions ?? [],
            )
          : composeEmptySpacePrompt(autoOpen, input.instruction);
  return withSkillPointer(directive);
}

export function composeTerminalLaunchPrompt(input: HandoffDispatchInput, cli: TerminalCli): string {
  const hasInstruction = typeof input.instruction === 'string' && input.instruction.trim() !== '';
  if (input.compose !== undefined || input.createDescription !== undefined || hasInstruction) {
    return `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, TERMINAL_CLIS[cli].handoffTarget, false)}`;
  }
  return composeTerminalBareLaunchPrompt(input.docContext?.relativePath ?? null);
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
      deps.toast.error(`Couldn't install OpenKnowledge skill — ${message}`);
      return { ok: false, reason: 'dispatch-error', detail: `install-error: ${message}` };
    }
    if (installOutcome.kind === 'installed-now') {
      deps.toast.success(
        'OpenKnowledge skill saved. Upload it in Claude Desktop, then click Cowork again.',
      );
      return { ok: true };
    }
    if (installOutcome.kind === 'install-failed') {
      const detail = installOutcome.message ?? installOutcome.reason;
      deps.toast.error(`Couldn't install OpenKnowledge skill — ${detail}`);
      return { ok: false, reason: 'dispatch-error', detail: `install-failed: ${detail}` };
    }
  }

  const payload: HandoffPayload = {
    target,
    projectDir: input.projectDir,
    docPath: input.docPath,
    prompt: selectScopedPrompt(input, target, deps.autoOpen),
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
