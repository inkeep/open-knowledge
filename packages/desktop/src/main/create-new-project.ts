/**
 * Pure helpers + IPC handler body for the Create-new-project dialog cascade.
 *
 * Renderer-side cascade in `CreateProjectDialog` does the friendly pre-submit
 * UX (red banner, inline error); the IPC handler `ok:project:create-new`
 * re-runs every check server-side as defense-in-depth — the renderer is
 * untrusted at the IPC boundary, and a stale dialog state (or a hostile
 * renderer) must not be able to scaffold a project inside an existing one.
 *
 * Functions split out from `index.ts` so the unit tier can exercise them
 * directly with `mkdtempSync` trees, without an Electron `app` / `dialog` /
 * `BrowserWindow` runtime.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addOkPathsToGitExclude,
  getOkArtifactPaths,
  type ProjectAiIntegrationsResult,
  writeProjectAiIntegrations,
} from '@inkeep/open-knowledge';
import {
  ALL_EDITOR_IDS,
  type EditorId,
  type OkFolderState,
  sanitizeFolderName,
} from '@inkeep/open-knowledge-core';
import {
  type EnsureProjectGitResult,
  ensureProjectGit,
  findEnclosingProjectRoot,
  initContent,
  tracedMkdirSync,
  writeRootGitignoreForNewRepo,
} from '@inkeep/open-knowledge-server';
import {
  type DiscoverProjectOptions,
  type DiscoverProjectResult,
  discoverProject as defaultDiscoverProject,
} from './folder-admission.ts';

/**
 * Classify a path for the cascade. Any stat error treats the path as `'free'`
 * — the same fall-through the renderer's `bridge.fs.folderState` contract
 * advertises. This is deliberately permissive: if we can't read the parent,
 * the `mkdir` step inside `runCreateNew` will surface the real error.
 */
export function folderState(path: string): OkFolderState {
  try {
    if (!existsSync(path)) return 'free';
    const st = statSync(path);
    if (!st.isDirectory()) {
      // A file occupies the name; the folder can't be "free" so we treat it
      // as non-empty for the cascade. Block-with-message is friendlier than
      // letting `mkdir` produce an EEXIST one step later.
      return 'exists-nonempty';
    }
    const entries = readdirSync(path);
    return entries.length === 0 ? 'exists-empty' : 'exists-nonempty';
  } catch (err) {
    // ENOENT collapses naturally to 'free'. Non-ENOENT (EACCES, ELOOP, …)
    // also fall through to 'free' per the contract, but leave a diagnostic
    // breadcrumb: when a user reports "cascade said free but submit failed
    // with mkdir-failed", the warn line points at the swallowed stat error.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        `[create-new-project] folderState swallowed ${code ?? 'unknown'} at ${path}: ${(err as Error).message}`,
      );
    }
    return 'free';
  }
}

/**
 * Re-export `sanitizeFolderName` from core so existing main-process callers
 * (the IPC handler in `index.ts` and the integration tests) keep their
 * existing import path. The renderer's `CreateProjectDialog` imports the
 * same function directly from `@inkeep/open-knowledge-core` — there is no
 * second copy.
 */
export { sanitizeFolderName };

import type { CreateNewProjectFailureReason } from '@inkeep/open-knowledge-core';

export class CreateNewProjectError extends Error {
  readonly reason: CreateNewProjectFailureReason;
  readonly details?: Record<string, unknown>;
  constructor(
    reason: CreateNewProjectFailureReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    // Embed the reason in the wire-format message. Electron's IPC strips
    // Error subclass identity across the boundary — the renderer sees only
    // `.message`. The dialog's `parseCreateNewError` recovers the structured
    // reason by prefix-matching `<reason>:`, so it MUST live in the message.
    super(`${reason}: ${message}`);
    this.name = 'CreateNewProjectError';
    this.reason = reason;
    this.details = details;
  }
}

/** Outcome of a successful `runCreateNew` call. */
interface CreateNewProjectSuccess {
  /** Absolute path the user-facing folder was created at (always equals
   *  `parent/sanitizeFolderName(name)`). Distinct from `projectDir` whenever
   *  git-root promotion fires: the visible folder lives at `target`, the
   *  project's `.ok/config.yml` lives at `projectDir`. */
  readonly target: string;
  /** Absolute path of the project root — where `.ok/config.yml`,
   *  `.gitignore`, and AI-editor integration files land. Equal to `target`
   *  when no promotion happens; the enclosing git working-tree root when
   *  `discoverProject` promoted (one `.ok/` per git repo). */
  readonly projectDir: string;
  /** Always `'.'` — opened folder and content scope align by default,
   *  even on git-root promotion. The picked sub-folder is intentionally
   *  NOT used as a default scope; users narrow via post-init `content.dir`
   *  in `.ok/config.yml`. Kept on the result shape for telemetry parity
   *  with `discoverProject`'s return; treat as a constant. */
  readonly defaultContentDir: string;
  /** True when `discoverProject` promoted the project root upward to an
   *  enclosing git working-tree root strictly below `homeDir`. */
  readonly gitRootPromoted: boolean;
  /** Per-(editor × integration) outcomes from `writeProjectAiIntegrations`
   *  (caller forwards to the `logAiIntegrationOutcomes` log helper). */
  readonly aiIntegrations: ProjectAiIntegrationsResult;
  /** Telemetry flow-kind variant: `'create-new-default'`
   *  when every available editor was selected, `'create-new-customized'`
   *  otherwise. */
  readonly variant: 'create-new-default' | 'create-new-customized';
  /**
   * Outcome of the post-scaffold sharing
   * transition. `shared` is the default and a no-op. `local-only` carries
   * the apply/refusal/no-exclude shape so the IPC handler can log.
   */
  readonly sharingOutcome: CreateNewSharingOutcome;
}

/**
 * Validate `editors` against the source-of-truth enum. Returns the array
 * unchanged when every entry is a known `EditorId`; throws an `invalid-args`
 * error otherwise. The renderer-side dialog only surfaces `ALL_EDITOR_IDS`
 * checkboxes, but the IPC body is untrusted.
 */
function validateEditors(editors: readonly string[]): EditorId[] {
  const known = new Set<string>(ALL_EDITOR_IDS);
  const out: EditorId[] = [];
  for (const id of editors) {
    if (!known.has(id)) {
      throw new CreateNewProjectError(
        'invalid-args',
        `Unknown editor id: ${JSON.stringify(id)}. Valid options: ${ALL_EDITOR_IDS.join(', ')}`,
      );
    }
    out.push(id as EditorId);
  }
  return out;
}

/**
 * Args contract for `runCreateNew`. Pre-sanitized at the handler boundary;
 * `sanitizeFolderName` is applied inside.
 */
interface CreateNewProjectArgs {
  readonly parent: string;
  readonly name: string;
  readonly editors: readonly string[];
  /**
   * Sharing posture chosen at create-time.
   * Optional in the type to keep callers that don't care backward-
   * compatible; the runtime default is `'shared'` (the
   * team-friendly default). Routed through `addOkPathsToGitExclude` after
   * `writeProjectAiIntegrations` so the create-new dialog and the
   * Pick-Existing consent dialog share one sharing-transition site.
   */
  readonly sharing?: 'shared' | 'local-only';
}

/**
 * Injection seam so tests can stub `discoverProject` without standing up a
 * fake git binary or content tree. Production callers pass the real
 * `discoverProject` from `folder-admission.ts` (the default).
 */
export interface RunCreateNewDeps {
  readonly discoverProject?: (
    pickedPath: string,
    opts: DiscoverProjectOptions,
  ) => Promise<DiscoverProjectResult>;
}

/**
 * Run the create-new-project scaffold spine. Pure-ish: takes args, returns
 * the success record (or throws `CreateNewProjectError`). Does NOT open a
 * window, does NOT touch `appState` — caller wires those concerns since
 * they require Electron runtime access. The handler in `index.ts` composes:
 *
 *   1. runCreateNew(args)
 *   2. persist `lastUsedProjectParent`
 *   3. recordOnboardingFlow(...)
 *   4. openProjectOrFallbackToNavigator(result.projectDir, 'create-new')
 *
 * Git-root promotion: `discoverProject` is the canonical authority for "does
 * this picked path sit inside an existing git working tree under $HOME." When
 * it promotes, `.ok/config.yml`, the AI-editor integration files, and the
 * `.git/`-root sit at `projectDir` (the git root). The user-facing folder
 * still exists at `target` (mkdir'd up front so the user sees it in Finder)
 * but is recorded inside the project's `content.dir` so the editor's file
 * tree shows it as a sub-scope. Mirrors the existing Pick-existing flow's
 * `kind: 'fresh' + gitRootPromoted` branch in `openProject`.
 */

/**
 * Outcome shape for runCreateNew's
 * sharing-transition step. Distinct from `SharingOutcome` in init.ts because
 * runCreateNew (a) doesn't surface a CLI-summary line, and (b) cannot
 * realistically hit the `localOnlyRequested + no-git` branch (it just
 * `ensureProjectGit`'d). The shape stays minimal and the IPC handler
 * narrows on `kind` for the structured log.
 */
export type CreateNewSharingOutcome =
  | { kind: 'shared' }
  | { kind: 'local-only-applied'; appended: string[]; alreadyPresent: string[] }
  | {
      kind: 'local-only-refused-tracked';
      tracked: string[];
      remediation: string;
    }
  | {
      kind: 'local-only-no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

function applyCreateNewLocalOnly(projectDir: string): CreateNewSharingOutcome {
  const paths = getOkArtifactPaths(projectDir);
  const result = addOkPathsToGitExclude(projectDir, paths);
  if (result.kind === 'refused-tracked') {
    return {
      kind: 'local-only-refused-tracked',
      tracked: [...result.tracked],
      remediation: result.remediation,
    };
  }
  if (result.kind === 'no-exclude') {
    return { kind: 'local-only-no-exclude', reason: result.reason };
  }
  return {
    kind: 'local-only-applied',
    appended: result.appended,
    alreadyPresent: result.alreadyPresent,
  };
}

export async function runCreateNew(
  args: CreateNewProjectArgs,
  deps: RunCreateNewDeps = {},
): Promise<CreateNewProjectSuccess> {
  const discoverProject = deps.discoverProject ?? defaultDiscoverProject;

  // 1. Validate args structurally. Reject malformed shapes before any fs
  //    access so a hostile renderer can't trigger a partial filesystem
  //    state by sending {parent: null, name: '../escape', ...}.
  if (typeof args.parent !== 'string' || args.parent.length === 0) {
    throw new CreateNewProjectError('invalid-args', 'parent must be a non-empty string');
  }
  if (typeof args.name !== 'string') {
    throw new CreateNewProjectError('invalid-args', 'name must be a string');
  }
  if (!Array.isArray(args.editors)) {
    throw new CreateNewProjectError('invalid-args', 'editors must be an array');
  }

  const editors = validateEditors(args.editors);
  const sanitized = sanitizeFolderName(args.name);
  if (sanitized.length === 0) {
    throw new CreateNewProjectError('invalid-args', 'name is empty after sanitization');
  }

  const parent = resolve(args.parent);
  const target = resolve(parent, sanitized);

  // 2. Defense-in-depth: enclosing-project block. The renderer's cascade
  //    should have already short-circuited this, but a stale dialog or a
  //    raced filesystem change can flip the result between probe and submit.
  const enclosing = findEnclosingProjectRoot(parent);
  if (enclosing !== null) {
    throw new CreateNewProjectError(
      'nested-project',
      `Cannot create a project inside an existing project: ${enclosing.rootPath}`,
      { rootPath: enclosing.rootPath, distance: enclosing.distance },
    );
  }

  // 3. Defense-in-depth: target-non-empty block. `'exists-empty'` is allowed
  //    — the user may have `mkdir`'d the folder manually. Only an existing
  //    file or a directory with entries blocks the create.
  const state = folderState(target);
  if (state === 'exists-nonempty') {
    throw new CreateNewProjectError('target-not-empty', `Target folder is not empty: ${target}`, {
      target,
    });
  }

  // 4. mkdir the target (and any missing parent components). `tracedMkdirSync`
  //    with `recursive: true` is idempotent: an already-existing empty
  //    directory is a no-op, which is what the `'exists-empty'` branch
  //    above relies on for the manual-mkdir retry case.
  try {
    tracedMkdirSync(target, { recursive: true });
  } catch (err) {
    throw new CreateNewProjectError(
      'mkdir-failed',
      `Failed to create directory ${target}: ${(err as Error).message}`,
      { target, cause: (err as Error).message },
    );
  }

  // 5. Run discoverProject against the target. This is the canonical
  //    authority for git-root promotion (mirrors the existing Pick-existing
  //    flow in `openProject`). When the target sits under an existing git
  //    working tree strictly below `$HOME`, `discoverProject` returns
  //    `kind: 'fresh'` with `projectDir = gitRoot` and `defaultContentDir
  //    = '.'` (opened folder and content scope align by default — narrowing
  //    to the picked sub-folder is opt-in via post-init `content.dir`).
  //
  //    `dirSizeProbe: null`: the probe gates `kind: 'managed'` with
  //    `ancestorPromoted: true` (an existing `.ok/` at an ancestor). Step 2
  //    above already blocked the nested-project case, so the only ways
  //    discoverProject can return `'managed'` here are (a) a race where
  //    someone else created an ancestor `.ok/config.yml` between step 2 and
  //    this call (vanishingly rare; we throw `nested-project` after-the-fact)
  //    or (b) a logic bug. Passing `null` keeps the probe out of the path.
  let discovery: DiscoverProjectResult;
  try {
    discovery = await discoverProject(target, { dirSizeProbe: null });
  } catch (err) {
    throw new CreateNewProjectError(
      'discovery-failed',
      `discoverProject failed at ${target}: ${(err as Error).message}`,
      { target, cause: (err as Error).message },
    );
  }

  if (discovery.kind === 'rejected') {
    // `target` was just mkdir'd — unreadable / symlink-escape should not
    // surface here. Treat as a hard failure rather than silently scaffolding
    // at a wrong location.
    throw new CreateNewProjectError(
      'discovery-failed',
      `discoverProject rejected ${target}: ${discovery.reason}`,
      { target, reason: discovery.reason },
    );
  }
  if (discovery.kind === 'managed' || discovery.kind === 'managed-requires-confirmation') {
    // Race: an enclosing `.ok/config.yml` materialized between the step-2
    // nesting check and this call. Surface the same structured error so
    // the renderer's error path is identical to the upfront-detected case.
    throw new CreateNewProjectError(
      'nested-project',
      `Cannot create a project inside an existing project: ${discovery.projectDir}`,
      { rootPath: discovery.projectDir, distance: 0 },
    );
  }

  const projectDir = discovery.projectDir;
  const defaultContentDir = discovery.defaultContentDir;
  const gitRootPromoted = discovery.gitRootPromoted;

  // 6. Initialize `.git/` at projectDir IFF no ancestor is already a git
  //    work tree. When discoverProject promoted to a git root, projectDir
  //    already has `.git/` and this is a no-op (idempotent). When no
  //    promotion happened (projectDir === target), this either initializes
  //    a fresh repo at target or no-ops because some ancestor is a repo.
  let gitResult: EnsureProjectGitResult;
  try {
    gitResult = await ensureProjectGit(projectDir);
  } catch (err) {
    throw new CreateNewProjectError(
      'git-init-failed',
      `git init failed at ${projectDir}: ${(err as Error).message}`,
      { projectDir, cause: (err as Error).message },
    );
  }

  // 7. Write `.ok/.gitignore` + `.ok/config.yml` + `.okignore`. `initContent`
  //    is idempotent via `writeIfMissing` — a retry after a mid-step crash
  //    will skip files that already landed. `defaultContentDir` is always
  //    `'.'` here (see the field's JSDoc), so the second arg is always
  //    `{ contentDir: undefined }` — the scaffolded config.yml's
  //    `content.dir` line stays commented out (the documented default).
  try {
    initContent(projectDir, {
      contentDir: defaultContentDir !== '.' ? defaultContentDir : undefined,
    });
  } catch (err) {
    throw new CreateNewProjectError(
      'init-failed',
      `initContent failed at ${projectDir}: ${(err as Error).message}`,
      { projectDir, cause: (err as Error).message },
    );
  }

  // 7b. Seed a project-root `.gitignore` with `.DS_Store` IFF we just ran
  //     `git init` above. Skipped when an enclosing repo already exists or
  //     promotion put projectDir on a pre-existing `.git/` — its
  //     `.gitignore` belongs to the user/org. `writeIfMissing` semantics
  //     inside the helper guarantee hand-authored files stay untouched on
  //     re-init. Symlink-detection errors are non-fatal: project creation
  //     succeeded and the seed is a quality-of-life convenience, not a
  //     correctness requirement.
  if (gitResult.didInit) {
    try {
      writeRootGitignoreForNewRepo(projectDir);
    } catch (err) {
      console.warn(
        `[create-new-project] skipping .gitignore seed at ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 8. Wire AI-editor integrations at projectDir (the git root if promoted)
  //    — MCP config + the project-local runtime skill for each editor land
  //    at the same root as `.ok/config.yml`, otherwise editors that look at
  //    the project root wouldn't see them. `writeProjectAiIntegrations` never
  //    throws; per-(editor × integration) failures land in `integrations`.
  const aiIntegrations = writeProjectAiIntegrations(projectDir, [...editors]);

  // 9. Sharing-mode transition.
  //    Mirrors the consent-dialog flow in main/index.ts — same single
  //    `addOkPathsToGitExclude` site. A fresh `runCreateNew` cannot
  //    realistically hit the tracked-files refusal (no upstream commits
  //    exist on the just-init'd .git), but we still route through the
  //    same code path so behavior cannot drift.
  const desiredSharing: 'shared' | 'local-only' =
    args.sharing === 'local-only' ? 'local-only' : 'shared';
  const sharingOutcome: CreateNewSharingOutcome =
    desiredSharing === 'local-only' ? applyCreateNewLocalOnly(projectDir) : { kind: 'shared' };

  const variant: CreateNewProjectSuccess['variant'] =
    editors.length === ALL_EDITOR_IDS.length ? 'create-new-default' : 'create-new-customized';

  return {
    target,
    projectDir,
    defaultContentDir,
    gitRootPromoted,
    aiIntegrations,
    variant,
    sharingOutcome,
  };
}

/**
 * Resolve the default parent location for the Create-new-project dialog.
 * Returns the persisted last-used parent when set and still on disk; falls
 * back to `<documents>/OpenKnowledge` otherwise. The fallback path is NOT
 * created here — the dialog's "Create" submit is the only write path.
 *
 * `documentsDir` + `existsCheck` are injectable so tests don't depend on
 * `app.getPath('documents')` or the real fs.
 */
export function resolveDefaultProjectsRoot(
  persistedParent: string | null,
  documentsDir: string,
  existsCheck: (p: string) => boolean = existsSync,
): string {
  if (persistedParent !== null) {
    try {
      if (existsCheck(persistedParent)) return persistedParent;
    } catch (err) {
      // existsSync swallows most errors; defensive try/catch covers the
      // edge case of an injected probe that throws (ELOOP, ENAMETOOLONG).
      console.warn('[create-new-project] persisted lastUsedProjectParent existsCheck failed:', err);
    }
  }
  return resolve(documentsDir, 'OpenKnowledge');
}
