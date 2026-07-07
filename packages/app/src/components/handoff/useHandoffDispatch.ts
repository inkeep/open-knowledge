/**
 * React hook — single dispatch entry point used by every Open-in-Agent surface
 * (EditorHeader, CommandPalette, FileTree context menu). Composes the three
 * side-effects of a click:
 *
 *   (1) `dispatchHandoff` — route the payload to the per-target URL primitive.
 *   (2) `recordHandoff`   — append one JSONL line to `~/.ok/stats.jsonl`
 *                           (Electron-only in v0; web host no-op).
 *   (3) sonner toast       — success / failure + retry action.
 *
 * Repo convention (precedent: `CommandPalette.runWithToast`, `useInstalledAgents`):
 * the pure, test-seam helper lives at module scope; the hook is a thin wrapper
 * that fills production dependencies. Unit tests exercise `runHandoffDispatch`
 * directly — no `@testing-library/react` / `happy-dom`.
 */

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
// Import from `config-context` (the lightweight context module) rather than
// `config-provider` so unit tests can `await import('./useHandoffDispatch')`
// without dragging the provider's heavy transitive deps (Hocuspocus, lingui
// macros) into a Bun-test context.
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
// Side-effect import only — loads the `Window.okDesktop?` global augmentation.
import '@/lib/desktop-bridge-types';

/**
 * Selection-scope payload carried on `HandoffDispatchInput.selection`. Holds
 * the passage the user selected plus the context the selection prompt needs:
 * which doc the passage lives in and what the user wants done with it.
 */
interface SelectionContext {
  /**
   * The active doc's path relative to the OK content dir, forward-slash
   * normalized with the `.md` suffix — the same POSIX form as
   * `DocContext.relativePath`.
   */
  readonly relativePath: string;
  /**
   * What the user wants the agent to do with the passage. Optional in the UI
   * — dispatch is allowed with no instruction typed — so callers normalize an
   * absent instruction to the empty string rather than omitting the field.
   */
  readonly instruction: string;
  /**
   * The selected passage serialized to markdown via the clipboard layer's
   * `sliceToMarkdown`.
   */
  readonly selectionMarkdown: string;
}

/**
 * Ask-scope payload carried on `HandoffDispatchInput.ask`. Pairs the active doc
 * with the user's typed instruction — the persistent bottom "Ask AI" composer's
 * no-selection freetext input. Mirrors `SelectionContext` minus the serialized
 * passage: ask scope references the doc by path only (the composer names it as
 * an `@`-mention) and never ships doc content, so it carries no telemetry scope
 * tag (it sits with the no-content directive scopes, not with selection).
 */
interface AskContext {
  /**
   * The active doc's path relative to the OK content dir, forward-slash
   * normalized with the `.md` suffix — the same POSIX form as
   * `DocContext.relativePath`. Sanitized at the composer boundary.
   */
  readonly relativePath: string;
  /**
   * What the user typed into the composer. The builder and `composeAskPrompt`
   * accept the empty string and degrade it to the bare doc directive, so callers
   * normalize an absent instruction to `''` rather than omitting the field.
   * (The current bottom-composer UI gates Send on non-empty input, but that is a
   * UI policy, not a contract of this field.)
   */
  readonly instruction: string;
}

/**
 * Compose-scope payload carried on `HandoffDispatchInput.compose` — the unified
 * "Ask AI" composer surface. Mirrors `AssembleHandoffPromptInput` minus
 * the dispatch-time `target` / `autoOpen` (both supplied by `runHandoffDispatch`),
 * so `selectScopedPrompt` maps it 1:1 into the holistic assembler.
 *
 * Three scopes:
 *   - **doc** — a doc is open: it is the scope lead (auto `@`-mentioned) and may
 *     carry a selected passage (`selection`: inline text, a line range, or an
 *     anchor). Explicit chip mentions ride on `mentions`.
 *   - **folder** — a folder view is open: the folder is the scope lead (auto
 *     `@`-mentioned), with no selectable passage. Explicit chip mentions ride on
 *     `mentions`. Surfaces: the folder-page bottom "Ask AI" composer.
 *   - **project** — no doc or folder open: the bare project directive is the
 *     lead, no selection. `buildComposerHandoffInput` derives the scope from
 *     whether a `docName` / `folderRelativePath` is present.
 *
 * `mentions` is the ordered list of resolved, workspace-relative `@path` tokens
 * (one per chip); the assembler sanitizes each via `sanitizePathForAtMention`
 * and never trims them under the URL budget (only instruction/selection give).
 */
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

/**
 * Caller-supplied input that selects the scope-specific prompt template and
 * carries the OS-native paths the per-target URL builders thread into the URL.
 *
 * Four scopes, signaled via the `docContext` / `folderRelativePath` /
 * `selection` fields:
 *
 *   - **File scope** — `docContext` set, `folderRelativePath` absent. Surfaces:
 *     EditorHeader (active doc), CommandPalette, FileTree file-row submenu.
 *     `runHandoffDispatch` composes via `composeFilePrompt(relativePath)`.
 *   - **Folder scope** — `docContext: null`, `folderRelativePath` set, `docPath`
 *     `''`. Surfaces: FileTree folder-row submenu, EditorHeader sparkle when a
 *     folder view is active. Composes via `composeFolderPrompt(folderRelativePath)`.
 *   - **Project / empty-space scope** — both `docContext: null` AND
 *     `folderRelativePath` absent. `docPath` `''`. Surfaces: empty-space
 *     right-click, EditorHeader sparkle with no active target. Composes via
 *     `composeEmptySpacePrompt()`.
 *   - **Selection scope** — `selection` set. Surface: the editor's "Edit
 *     with AI" affordance (the WYSIWYG bubble-menu button). `selection`
 *     carries the active doc's relative path, the user's instruction, and
 *     the markdown-serialized passage.
 *   - **Ask scope** — `ask` set. Surface: the persistent bottom "Ask AI"
 *     composer. `ask` carries the active doc's relative path and the user's
 *     typed instruction (no passage). Composes via
 *     `composeAskPrompt(relativePath, instruction, autoOpen, target)`.
 *
 * `projectDir` is the OS-native absolute path the URL builders thread into
 * `folder=` (Claude family) / `path=` (Codex) / `workspace=<basename>` (Cursor).
 * Always `workspace.contentDir` across all three scopes — folder scope conveys
 * its narrower focus via `composeFolderPrompt(folderRelativePath)` in the
 * directive prompt, not via cwd. See `buildFolderHandoffInput` for rationale.
 *
 * The helpers in this module own construction; call sites never assemble the
 * shape by hand.
 */
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

/**
 * Shared helper for the three surfaces (EditorHeader, CommandPalette, FileTree)
 * that all construct a `HandoffDispatchInput` the same way: from an extension-
 * less doc path (`activeDocName` or a right-clicked tree-node's `path`) plus
 * the workspace root / OS separator.
 *
 * Returns `null` when either input is missing — mirrors the
 * `OpenInAgentMenu.input` contract ("disabled trigger when nothing to dispatch").
 *
 * Centralizing the construction here guarantees that every surface:
 *   - Uses the same `.md`-suffix convention (via `docNameToRelativePath`).
 *   - Joins with the advertised separator (via `joinWorkspacePath`).
 *   - Sets `docContext.relativePath` to the exact same POSIX form that the
 *     prompt composer and MCP server consume.
 */
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

/**
 * Project-scoped variant of `buildHandoffInput` — for surfaces where the user
 * is choosing a launcher target but hasn't picked a doc (post-init empty-state
 * "Open in <editor>" cards, empty-space right-click, sparkle icon with no
 * active target). Returns a `HandoffDispatchInput` with `docContext` null,
 * `folderRelativePath` omitted, and `docPath` empty; `runHandoffDispatch`
 * composes via `composeEmptySpacePrompt()` and the URL builders drop the
 * file param.
 *
 * Returns `null` when the workspace isn't loaded yet (same contract as
 * `buildHandoffInput` — caller renders the cards disabled while null).
 */
export function buildProjectScopedHandoffInput(args: {
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  // Treat an empty contentDir as "not ready" too: the URL builders would
  // otherwise emit `claude://cowork/new?folder=` with an empty folder param.
  // The shape is technically valid TypeScript but never occurs from a healthy
  // server contract; guarding here matches the disabled-card semantics on
  // the consumer side.
  if (!args.workspace?.contentDir) return null;
  return {
    docContext: null,
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

/**
 * Create-scoped variant — for the empty-state "Create with <agent>" composer,
 * where the user typed a free-form brief describing the knowledge base they
 * want to scaffold. Mirrors `buildProjectScopedHandoffInput` (no active doc,
 * cwd at `contentDir`) but carries the brief on `createDescription` so
 * `runHandoffDispatch` composes via `composeCreatePrompt` instead of the bare
 * project directive.
 *
 * `description` is passed through verbatim (trimming + blockquoting happen in
 * the composer); the empty string is a valid input and still routes to the
 * create composer, which degrades to the bare scaffold directive.
 *
 * Returns `null` when the workspace isn't loaded yet — same disabled-trigger
 * contract as the sibling builders.
 */
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

/**
 * Open a target's `installUrl` in the user's browser. Wraps `openExternal`
 * inside this allowlisted file so non-handoff surfaces (e.g. the empty-state
 * composer's "install an agent" nudge) can offer an Install CTA without
 * importing `@/lib/handoff/open-external` directly — that import outside the
 * handoff subpackage would fail the `dispatch-single-entry-point` meta-test.
 */
export function openInstallUrl(target: TargetData): Promise<void> {
  return defaultOpenExternal(target.installUrl).then(() => undefined);
}

/**
 * Folder-scoped variant — for the sidebar's right-click submenu on folder rows
 * and the EditorHeader sparkle icon when a folder view is active. `workspace`
 * is threaded for the not-ready guard so callers don't need a pre-call
 * conditional.
 *
 * `folderRelativePath` is the discriminator that lets `runHandoffDispatch`
 * select between the folder and empty-space prompt templates when `docContext`
 * is null. The caller already has the relative path in hand
 * (`relativePathForTreeItem(item)` in FileTree); passing it through removes
 * the need to thread `workspace` into the dispatch hook to re-derive it.
 *
 * **Folder scope lands the launched agent's cwd at `workspace.contentDir`,
 * NOT at the folder's absolute path** — same as file + project scope. Reasons:
 *   1. Project-level agent tooling (`.claude/launch.json`, `AGENTS.md`,
 *      `CLAUDE.md`, `.codex/`, MCP settings, hooks) lives at `contentDir`;
 *      launching cwd inside a sub-folder breaks tools that don't walk up.
 *      Concretely, Claude Code's `preview_start` failed because it looked for
 *      `<folder>/.claude/launch.json`.
 *   2. OK MCP walks up from cwd to find `.ok/` and serves the whole
 *      `contentDir` regardless, so a folder cwd doesn't actually scope OK
 *      reads/writes — it only narrows native fs tools, which isn't a contract
 *      we want to rely on.
 *   3. Folder scoping is already conveyed via `composeFolderPrompt(folderRelativePath)`
 *      in the directive prompt; the cwd shouldn't carry redundant signal.
 */
export function buildFolderHandoffInput(args: {
  readonly folderRelativePath: string;
  readonly workspace: Workspace | null;
}): HandoffDispatchInput | null {
  if (!args.workspace?.contentDir) return null;
  // Empty relative path indicates the caller couldn't derive a tree-item-
  // relative path (renderer bug). Short-circuit cleanly rather than emit a
  // URL with an empty discriminator.
  if (!args.folderRelativePath) return null;
  return {
    docContext: null,
    folderRelativePath: args.folderRelativePath,
    projectDir: args.workspace.contentDir,
    docPath: '',
  };
}

/**
 * Selection-scoped variant — for the editor "Edit with AI" affordance (the
 * WYSIWYG bubble-menu button). Builds the input from the active doc's
 * extension-less name, the user's instruction, and the passage the user
 * selected, already serialized to markdown.
 *
 * `relativePath` and `docPath` are derived exactly as `buildHandoffInput`
 * does: selection scope names a real doc, so `docPath` carries the doc's
 * absolute path (consistent with file scope) even though no URL builder
 * threads it — it stays available for callers / telemetry.
 *
 * Returns `null` when there is nothing to dispatch — no active doc, no loaded
 * workspace, or an empty serialized selection. The affordance is render-gated
 * on a non-empty selection, so an empty `selectionMarkdown` here is a renderer
 * bug; short-circuit rather than compose a degenerate empty-fence prompt
 * (mirrors `buildFolderHandoffInput`'s empty-`folderRelativePath` guard). An
 * empty `instruction` is valid — dispatch is allowed without one.
 */
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

/**
 * Skill-scoped variant — for the Skills manager's "Open with AI" affordance
 * (author-with-AI). Hands the named skill to an installed agent so it authors
 * it via the `open-knowledge-write-skill` meta-skill. The skill is addressed by
 * name + scope (the agent reaches it through OK MCP), so there is no doc/folder
 * path: `docContext` is null and `docPath` empty, exactly like project scope.
 * `projectDir` is the launched agent's cwd (always `workspace.contentDir`, even
 * for a global skill — the agent edits the global store via OK MCP).
 *
 * Returns `null` when the workspace isn't loaded or the name is empty (the
 * affordance is render-gated on both, so an empty value here is a renderer bug).
 */
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

/**
 * Ask-scoped variant — for the persistent bottom "Ask AI" composer. Builds the
 * input from the active doc's extension-less name, the loaded workspace, and
 * the user's typed instruction. `relativePath` and `docPath` are derived
 * exactly as `buildHandoffInput` / `buildSelectionHandoffInput` do; ask scope
 * names a real doc, so `docPath` carries the doc's absolute path (informational
 * only — no URL builder threads `docPath`).
 *
 * Returns `null` when there is nothing to dispatch — no active doc or no loaded
 * workspace (same disabled-trigger contract as the sibling builders). An empty
 * `instruction` is a valid builder input: `composeAskPrompt` degrades it to the
 * bare doc directive, so it is NOT a null trigger (mirrors
 * `buildSelectionHandoffInput`'s empty-instruction tolerance). The current
 * bottom-composer UI separately gates Send on non-empty input.
 *
 * The dedicated `ask` discriminator is load-bearing: it keeps the dispatch off
 * `composeFilePrompt`'s no-selection path, which carries no instruction and
 * would silently drop the user's typed text.
 */
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

/**
 * Compose-scoped builder — the unified "Ask AI" composer's single construction
 * point. Scope is derived from `docName` / `folderRelativePath` presence,
 * mirroring the composer's own surface: a non-null `docName` yields doc scope
 * (the doc is the auto `@`-mentioned scope lead and may carry a selection
 * passage); a `folderRelativePath` (with no `docName`) yields folder scope (the
 * folder is the auto `@`-mentioned lead, no selection); neither yields project
 * scope (bare project directive). All ride the holistic `assembleHandoffPrompt`
 * via the `compose` field rather than a per-composer fit that would silently
 * drop the typed context.
 *
 * `mentions` is the ordered list of resolved workspace-relative `@path` tokens
 * (one per composer chip), passed straight through; the assembler sanitizes each
 * and never trims them under the URL budget. `selection` is honored for doc scope
 * only (it is irrelevant at folder / project scope — no active doc to select
 * within); the composer decides its kind (inline / lines / anchor) from the
 * selection size.
 *
 * Returns `null` only when the workspace isn't loaded yet — same disabled-trigger
 * contract as the sibling builders. Unlike `buildAskHandoffInput`, a null
 * `docName` is NOT a null trigger: it is the folder- or project-scope signal.
 */
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
    // Narrow on the value so the field is fully absent (not an explicit
    // `undefined`) in the no-selection branch — exactOptionalPropertyTypes.
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

/**
 * Selection-or-file helper for editor "Edit with AI" surfaces. It preserves
 * the existing fallback contract: prefer a selection-scoped handoff when the
 * serialized passage is non-empty, otherwise fall back to the active document
 * handoff. Toast/error handling stays caller-local because the UI surfaces use
 * different copy and timing.
 */
export function buildSelectionOrDocHandoffInput(args: {
  readonly docName: string | null;
  readonly workspace: Workspace | null;
  readonly instruction: string;
  readonly selectionMarkdown: string;
}): HandoffDispatchInput | null {
  return buildSelectionHandoffInput(args) ?? buildHandoffInput(args);
}

/**
 * Shape of the sonner action affordance — mirrors sonner's public API so we
 * don't leak their full option surface to callers. `label` is the button text;
 * `onClick` runs when the user taps the button.
 */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

/**
 * Narrow sonner surface the hook uses. Tests inject a recording double; the
 * production hook uses `sonnerToast.{success,error}`.
 */
export interface ToastSurface {
  success(message: string): void;
  error(message: string, options?: { action?: ToastAction }): void;
}

/**
 * Dependencies injected into `runHandoffDispatch`. Every field has a
 * production default built by `defaultHandoffDispatchDeps()`; tests pass
 * recording doubles to assert call arguments.
 */
export interface HandoffDispatchDeps {
  readonly dispatchHandoff: (payload: HandoffPayload) => Promise<HandoffOutcome>;
  readonly recordHandoff: (line: HandoffStatsLine) => Promise<void>;
  readonly toast: ToastSurface;
  /** Clock — ISO timestamp of the dispatch event. Deterministic in tests. */
  readonly now: () => Date;
  /** Host classifier — populates `host` on telemetry lines. */
  readonly isElectronHost: () => boolean;
  /** Lookup display name for toast copy; falls back to the target id. */
  readonly getDisplayName: (target: HandoffTarget) => string;
  /**
   * Lazy install gate for Claude Cowork. Runs `okDesktop.skill.buildAndOpen()`
   * on the first Cowork click per skill version, then becomes a no-op via a
   * localStorage guard (see `cowork-skill-install.ts`). Web hosts return
   * `host-unsupported` and `runHandoffDispatch` falls through to URL dispatch.
   */
  readonly ensureCoworkSkillInstalled: () => Promise<EnsureCoworkSkillOutcome>;
  /**
   * Resolved `appearance.preview.autoOpen` value at dispatch time. Threads
   * into the scope-specific prompt template so the receiving agent's first-
   * turn directive honors the user's "agent opens my preview" preference. The
   * hook reads it from `useConfigContext().merged?.appearance?.preview
   * ?.autoOpen ?? true`; tests inject a literal. Defaults to `true` in
   * `defaultHandoffDispatchDeps()` so non-hook callers (and tests that omit
   * the field) preserve the legacy "agent opens preview" behavior.
   */
  readonly autoOpen: boolean;
}

/**
 * Maximum retry attempts offered for a failed dispatch. First failure offers
 * "Retry"; second failure offers "Try one more time"; third failure omits
 * the retry button (final-attempt copy instead). Bounded so a flaky network
 * cannot produce an infinite toast chain, each attempt firing its own
 * telemetry line.
 */
export const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * Success toast copy: `Opened in Claude Cowork.` / `Opened in Codex.` etc.
 * Exported for assertion in tests.
 */
export function successToastMessage(displayName: string): string {
  return `Opened in ${displayName}.`;
}

/**
 * Failure toast copy varies by attempt so the final-attempt message is
 * distinct from the prior retry-offers. Plain ASCII apostrophe (`\'`), not a
 * typographic one. Em-dash `—` (U+2014) matches the app's broader
 * failure-message shape (`EditorPane.tsx` uses
 * `Checkpoint failed — try again`).
 */
export function errorToastMessage(displayName: string, attempt = 1): string {
  if (attempt >= MAX_DISPATCH_ATTEMPTS) {
    return `Couldn't reach ${displayName} — please try again later.`;
  }
  if (attempt === MAX_DISPATCH_ATTEMPTS - 1) {
    return `Still couldn't reach ${displayName} — try one more time?`;
  }
  return `Couldn't reach ${displayName} — try again?`;
}

/**
 * Retry-button label. `null` on the final attempt (no retry offered).
 * Kept as a pure helper so tests can assert the cap directly.
 */
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
  // Spread `{}` rather than `scope: undefined` so a non-selection line omits
  // the key entirely — keeps the JSONL narrow and stays correct under
  // `exactOptionalPropertyTypes`.
  const scopeField = scope === undefined ? {} : { scope };
  if (outcome.ok) {
    return { target, host, outcome: 'ok', ts, ...scopeField };
  }
  return { target, host, outcome: 'error', ts, reason: outcome.reason, ...scopeField };
}

/**
 * Map a `ComposeContext` into the core assembler's discriminated input by
 * folding in the dispatch-time `target` + `autoOpen`. A doc-scope context with a
 * selection passes its markdown through as the assembler's `selection`; without
 * one the field stays absent (exactOptionalPropertyTypes). Folder scope carries a
 * folder lead and mentions but no selection; project scope carries neither a lead
 * nor a selection.
 */
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

/**
 * Pick the scope-specific prompt that matches the input's scope. Exported for
 * direct unit assertions; `runHandoffDispatch` is the only production caller.
 *
 *   - `compose` set     → compose scope     → assembleHandoffPrompt(scope + instruction + mentions[] + selection?, target)
 *   - `selection` set   → selection scope   → composeSelectionPrompt(..., target)
 *   - `ask` set         → ask scope         → composeAskPrompt(relativePath, instruction, autoOpen, target)
 *   - `docContext` set  → file scope        → composeFilePrompt(relativePath, autoOpen, instruction)
 *   - `folderRelativePath` truthy → folder scope → composeFolderPrompt(..., autoOpen, instruction)
 *   - `createDescription` set → create scope → composeCreatePrompt(..., autoOpen)
 *   - none of the above → empty-space scope → composeEmptySpacePrompt(autoOpen, instruction)
 *
 * `input.instruction` (the toolbar "Open with AI" prompt box) is threaded into
 * the file / folder / project directive composers; it is `undefined` for every
 * other surface, so the composers fall back to their bare directive. Selection
 * and create scope ignore it — they carry their own free-text.
 *
 * `compose` is checked first: it is the unified "Ask AI" composer path
 * and the only scope carrying explicit `@path` mentions + (optionally) both a
 * selection passage AND a project-scope freetext. It routes through the holistic
 * `assembleHandoffPrompt`, which budgets scope-lead + instruction + selection +
 * N mentions to the per-target encoded URL in ONE pass — never appending tokens
 * after a per-composer fit. `selection` and `ask` follow: they too are
 * freetext-bearing and need `target` to measure the post-encoding URL length
 * (`composeSelectionPrompt` to choose inline vs locus transport; `composeAskPrompt`
 * to fit the instruction within the per-target budget). `ask` is checked before
 * `docContext` so an ask dispatch never falls through to `composeFilePrompt`,
 * which carries no instruction.
 *
 * The branches are precedence-ordered, not mutually checked. At the helper
 * boundary the scopes are disjoint (`buildComposerHandoffInput` sets `compose`
 * only; `buildSelectionHandoffInput` `selection` only; `buildAskHandoffInput`
 * `ask` only; `buildHandoffInput` `docContext` only; `buildFolderHandoffInput`
 * `folderRelativePath` only; `buildProjectScopedHandoffInput` none). The ordering
 * is defensive — a caller that hand-constructs the shape with several fields
 * lands on the most specific scope, matching the implicit
 * "compose > selection > ask > file > folder > project" specificity ordering.
 *
 * `autoOpen` mirrors the user's `appearance.preview.autoOpen` preference and
 * controls whether each directive composer emits the trailing "Open the OK
 * editor." directive (see `prompt-composer.ts`). The selection composer is
 * not directive-bound — it carries the user's instruction unchanged regardless
 * of `autoOpen`.
 */
export function selectScopedPrompt(
  input: HandoffDispatchInput,
  target: HandoffTarget,
  autoOpen: boolean,
): string {
  if (input.compose) {
    return assembleHandoffPrompt(composeContextToAssembleInput(input.compose, target, autoOpen));
  }
  // Selection is excluded from the skill pointer: it already ends with an
  // explicit "read the passage via the OK MCP server" directive and is the most
  // URL-budget-constrained prompt (see `composeSelectionPrompt`).
  if (input.selection) {
    return composeSelectionPrompt({ ...input.selection, target });
  }
  // Skill scope (author-with-AI) carries its own `open-knowledge-write-skill`
  // directive, so it is excluded from the standing project skill pointer just
  // like selection scope.
  if (input.skill) {
    return composeSkillPrompt(input.skill.name, input.skill.scope, autoOpen);
  }
  if (input.ask) {
    return composeAskPrompt(input.ask.relativePath, input.ask.instruction, autoOpen, target);
  }
  // Every directive launch scope gets the standing skill pointer, applied once
  // here so the composers stay pure and the wording lives in one place. The
  // toolbar `input.instruction` (when present) is threaded into the directive
  // composers; create scope carries its own free-text and ignores it.
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

/**
 * Prompt for the docked-terminal "Open in terminal" launcher (the desktop-only
 * terminal panel in `EditorPane`). Two shapes:
 *
 *   - **Bare launch** (no instruction typed, no create brief) — the common case
 *     from the "Open in terminal" rows and the file-tree / empty-space context
 *     menus. Composes the minimal `composeTerminalBareLaunchPrompt`: state the
 *     surface, load the OK contract, read the open file if there is one, then
 *     stop. It does NOT invite open-ended work — the user drives the next turn
 *     from the terminal themselves. CLI-agnostic: the load + read + stop wording
 *     is identical across Claude / Codex / Cursor (no `@`-mention encoding to
 *     vary per target).
 *   - **Instruction / create launch** — the unified "Ask AI" composer (carries
 *     its intent in `input.compose`: instruction + `@`-mentions + optional
 *     selection passage), the toolbar "Open with AI" popover (top-level
 *     `input.instruction`), or the empty-state "Create with <CLI>" brief. These
 *     carry explicit user intent, so they keep the directive composers via
 *     `selectScopedPrompt`, composed against the CLI's handoff target
 *     (`TERMINAL_CLIS[cli].handoffTarget` — `claude→'claude-code'`,
 *     `codex→'codex'`, `cursor→'cursor'`) so the instruction / brief threads
 *     through identically to that target's deep-link. The preview trailer stays
 *     suppressed (`autoOpen: false`): the terminal launches alongside an
 *     already-open OK editor, so the "Open the OK editor in web view." directive
 *     would point the agent at a surface the user is already looking at. The web
 *     handoff keeps honoring the preference.
 *
 * Selection scope never reaches this path — it dispatches via the web handoff,
 * not the terminal.
 */
export function composeTerminalLaunchPrompt(input: HandoffDispatchInput, cli: TerminalCli): string {
  const hasInstruction = typeof input.instruction === 'string' && input.instruction.trim() !== '';
  // `input.compose` is the unified "Ask AI" composer's payload — it carries the
  // typed instruction in `compose.instruction`, NOT the top-level
  // `input.instruction` the toolbar popover uses. Checking only `hasInstruction`
  // would route every composer dispatch into the bare load+read+stop prompt and
  // silently drop the user's typed text; `selectScopedPrompt` already threads
  // `input.compose` through `assembleHandoffPrompt`, so route it there.
  if (input.compose !== undefined || input.createDescription !== undefined || hasInstruction) {
    // Typed intent: keep the user's instruction (via the directive composer,
    // which already prepends the skill pointer) but lead with the terminal-
    // surface preamble so the launch reads as the same OK handoff the bare
    // bootstrap establishes — context first, then the user's actual ask. The
    // bare branch's "Then stop." tail is replaced by that ask.
    return `${OK_TERMINAL_SURFACE_PREAMBLE} ${selectScopedPrompt(input, TERMINAL_CLIS[cli].handoffTarget, false)}`;
  }
  return composeTerminalBareLaunchPrompt(input.docContext?.relativePath ?? null);
}

/**
 * Pure test-seam helper. Called by the React hook with production deps; unit
 * tests call it directly with recording doubles.
 *
 * Behavior:
 *   - Compose `HandoffPayload` from input (adds the scope-specific prompt
 *     via `selectScopedPrompt(input, target, deps.autoOpen)`).
 *   - Call `dispatchHandoff` — never throws per its contract.
 *   - Append one telemetry line (fire-and-await; never throws per `recordHandoff`).
 *   - Fire a single sonner toast:
 *       ok    → `toast.success(successToastMessage(displayName))`
 *       error → `toast.error(errorToastMessage(displayName, attempt), { action })`
 *         where the action is present only when `attempt < MAX_DISPATCH_ATTEMPTS`.
 *         Retry action re-invokes `runHandoffDispatch` with `attempt + 1`; the
 *         final toast carries a distinct "please try again later" copy and no
 *         button (bounded — unbounded retry was a prior regression).
 *   - A retry is an independent dispatch attempt — records its own stats line
 *     and shows its own toast.
 *
 * `attempt` is 1-indexed and defaults to 1 for the initial dispatch. The cap
 * of `MAX_DISPATCH_ATTEMPTS` (3) means the user can retry at most twice after
 * the first failure; the third failure offers no Retry button.
 */
export async function runHandoffDispatch(
  target: HandoffTarget,
  input: HandoffDispatchInput,
  deps: HandoffDispatchDeps,
  attempt = 1,
): Promise<HandoffOutcome> {
  // First-click install gate for Claude Cowork. `installed-now` skips URL
  // dispatch this turn — Claude Desktop is already opening with the .skill
  // file; the user uploads it manually and clicks again to start a session.
  // `already-installed` and `host-unsupported` fall through to normal dispatch.
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
    // Compose the scope-specific prompt (see `selectScopedPrompt` for scope
    // routing). File / folder / project prompts are short directives; the
    // selection prompt also carries the selected passage inline, or a locus
    // anchor when the passage is too large for the URL budget. The URL still
    // carries no `file=` attach param, so the precedent #25 "no native
    // file-attach" invariant holds for every scope. `deps.autoOpen` is the
    // user's `appearance.preview.autoOpen` value, read fresh by the hook at
    // click time and threaded into directive composers so the receiving
    // agent's first turn honors the preference.
    prompt: selectScopedPrompt(input, target, deps.autoOpen),
  };

  const outcome = await deps.dispatchHandoff(payload);

  const host: HandoffHost = deps.isElectronHost() ? 'electron' : 'web';
  const ts = deps.now().toISOString();
  // Tag the telemetry scope on any dispatch that serializes and ships doc
  // content — the standalone selection scope, and a compose dispatch whose doc
  // scope carries a selection passage. Ask + a compose dispatch with no passage
  // carry no content (just `@`-mention paths plus the user's own instruction),
  // so they stay untagged alongside the directive scopes rather than reading as
  // a content-bearing handoff.
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

/**
 * Pure display-name resolver. Looks the target up in `KNOWN_TARGETS` and falls
 * back to the target id if (via an unsafe cast) an unknown value arrives.
 * Exported for test observability.
 */
export function getDisplayNameDefault(target: HandoffTarget): string {
  const entry = KNOWN_TARGETS.find((t) => t.id === target);
  return entry?.displayName ?? target;
}

/**
 * Pure host classifier — mirrors `useInstalledAgents.isElectronHostDefault`
 * so both hooks agree on host detection.
 */
export function isElectronHostDefault(
  windowLike: { okDesktop?: unknown } | undefined = typeof window !== 'undefined'
    ? window
    : undefined,
): boolean {
  return windowLike?.okDesktop != null;
}

/**
 * Production dependencies for `runHandoffDispatch`. Wraps module-level bindings
 * (`dispatchHandoff`, `recordHandoff`, `sonnerToast`) behind the pure DI shape.
 * `autoOpen` defaults to `true` — the hook overrides this with the live config
 * value at dispatch time, but non-hook callers (and tests that omit the field)
 * preserve the legacy "agent opens preview" behavior.
 */
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

/**
 * Result of the hook. A `dispatch` callback wraps the pure helper with
 * production deps for the three "Open with AI" mount sites (sparkle dropdown,
 * sidebar context submenu, CommandPalette agent group). A separate
 * `reinstallCoworkSkill` callback is the reinstall affordance — wire to a
 * settings/help menu item or install-toast retry link.
 */
interface UseHandoffDispatchResult {
  dispatch: (target: HandoffTarget, input: HandoffDispatchInput) => Promise<HandoffOutcome>;
  reinstallCoworkSkill: () => Promise<EnsureCoworkSkillOutcome>;
}

/**
 * Hook consumed by `OpenInAgentMenu` and its three mount sites. Returns a
 * stable `dispatch` callback; tests exercise the pure `runHandoffDispatch`
 * directly instead of mounting the hook.
 *
 * Reads `appearance.preview.autoOpen` from the live config at hook level so
 * each dispatch picks up the user's current preference without the dispatch
 * helper having to reach back into context. The lookup is `?? true` so the
 * legacy "agent opens preview" behavior holds during the cold-start window
 * before `merged` resolves.
 */
export function useHandoffDispatch(): UseHandoffDispatchResult {
  const { merged } = useConfigContext();
  const autoOpen = merged?.appearance?.preview?.autoOpen ?? true;
  return {
    dispatch: (target, input) =>
      runHandoffDispatch(target, input, { ...defaultHandoffDispatchDeps(), autoOpen }),
    reinstallCoworkSkill,
  };
}
