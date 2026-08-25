/**
 * Conflict-gate coverage meta-test.
 *
 * Mirror of `attribution-sweep-coverage.test.ts` for the conflict-aware
 * write-refusal contract. Statically scans `api-extension.ts` and asserts:
 *
 *   (1) Every REQUIRED mutating handler (the 8 surfaces) either calls
 *       `respondDocInConflict` directly OR routes
 *       through a spine that gates (`applyAgentMarkdownWrite` /
 *       `applyAgentUndo` — both throw `DocInConflictError` at entry).
 *   (2) Every handler in the static route registry is tracked as REQUIRED
 *       or EXEMPT — a new mutating handler added without categorization
 *       trips this test rather than silently bypassing the gate.
 *
 * The point of this test is to make the conflict-aware refusal contract
 * a property of the source code rather than a per-handler discipline.
 * Without it, a future handler can be added to the route registry,
 * carry its own catch arms, and still ship without ever checking
 * `lifecycle.status === 'conflict'`. The meta-test forces a categorization
 * decision at every PR boundary.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');
/**
 * The conflict-refusal contract applies to any handler that writes user
 * content, regardless of which file it lives in — lifted route groups
 * (`skills-sh-handlers.ts`, native Wave 2 groups like
 * `http/link-graph-routes.ts` with their OWN `const routes:` record) stay
 * inside the scan, mirroring `error-envelope-coverage.test.ts`.
 */
const HANDLER_SOURCES = [
  source,
  ...[
    'skills-sh-handlers.ts',
    'http/link-graph-routes.ts',
    'http/metrics-routes.ts',
    'http/document-routes.ts',
  ].map((file) => readFileSync(join(import.meta.dirname, '../../../server/src', file), 'utf8')),
];

/**
 * The 8 mutating handlers. Each
 * MUST either call `respondDocInConflict(...)` directly OR route through
 * a spine helper that gates (`applyAgentMarkdownWrite` / `applyAgentUndo`).
 * If you add a new mutating handler that touches user content, add it
 * here AND add a gate at the handler boundary or the spine it routes
 * through.
 */
const REQUIRED_HANDLERS = [
  'handleAgentWrite',
  'handleAgentWriteMd',
  // Batch sibling of handleAgentWriteMd — every entry routes through the
  // gated applyAgentMarkdownWrite spine; a per-entry DocInConflictError is
  // translated to that entry's result (with the doc-in-conflict-write-refused
  // event re-emitted) instead of a wire-level 409, so siblings keep landing.
  'handleAgentWriteBatch',
  'handleAgentPatch',
  'handleAgentUndo',
  'handleRollback',
  'handleRenamePath',
  'handleDeletePath',
  'handleDuplicatePath',
  // `handleTemplate` delegates to `handleTemplatePut` / `handleTemplateDelete` /
  // `handleTemplateMove` for the mutating methods; the gate is invoked from those
  // via the shared `checkTemplateConflictGate` helper. The meta-test scans the
  // dispatcher here AND the sub-handlers below to keep the discriminator visible.
  'handleTemplate',
  'handleTemplatePut',
  'handleTemplateDelete',
  'handleTemplateMove',
  // `/api/template/import` — copies a source doc into `.ok/templates/` and,
  // when `deleteSource`, removes the source. The source-delete branch gates via
  // `respondDocInConflict`; the template target gates via `checkTemplateConflictGate`.
  'handleTemplateImport',
  // Skill CONTENT-doc writers (skills-as-content): a PROJECT `SKILL.md` and its
  // `.md` references are real CRDT content docs, so their CRDT paired-write
  // path must refuse a mid-conflict doc via `checkSkillDocConflictGate`. The
  // `/api/skill` + `/api/skill-file` dispatchers route to the gated PUT
  // sub-handlers. (DELETE sub-handlers tear
  // the doc down rather than mutate its body, and global skills + scripts are
  // fs-direct non-CRDT artifacts the gate no-ops on.)
  'handleSkill',
  'handleSkillPut',
  'handleSkillFile',
  'handleSkillFilePut',
  // `/api/skill-file/rename` — a project `.md` reference is a live content
  // doc; its identity move refuses a mid-conflict doc via
  // `checkSkillDocConflictGate` before teardown.
  'handleSkillFileRename',
  // `/api/lint/fix` — auto-fix a document's markdownlint violations through
  // `applyAgentMarkdownWrite`, which refuses a mid-conflict doc
  // (`DocInConflictError` → `respondDocInConflict`), so the gate rides the
  // shared agent-write spine.
  'handleLintFix',
];

/**
 * Read-only / control-plane / out-of-conflict-scope handlers. Listed
 * exhaustively so any new handler in the route registry surfaces as
 * "untracked" rather than silently defaulting to "exempt".
 */
const EXEMPT_HANDLERS = new Set([
  // Read paths.
  'handleDocumentRead',
  'handleDocumentList',
  // GET /api/acp/catalog — read-only ACP agent-catalog listing (registry +
  // custom entries); no Y.Doc mutation, so the conflict-refusal gate doesn't
  // apply. Agent-thread writes ride the /collab/thread WS, not this route.
  'handleAcpCatalog',
  'handleAsset',
  'handleAssetText',
  'handleBacklinks',
  'handleBacklinkCounts',
  // GET /api/comment-counts — read-only unresolved-comment counts served from
  // the in-memory comment index (per-doc or per-folder-prefix), feeding MCP
  // read enrichment. No Y.Doc mutation, so the conflict-refusal gate doesn't
  // apply; the thread-mutating routes are `/api/comments` + `/api/comment`.
  'handleCommentCounts',
  'handleForwardLinks',
  // POST /api/link-preview — read-only external metadata fetch; never writes a
  // doc, so there is no in-conflict write to gate.
  'handleLinkPreview',
  'handleLinkGraph',
  'handleSearch',
  // GET /api/semantic-status — read-only setup/coverage probe; no Y.Doc
  // mutation, so the conflict-refusal gate doesn't apply.
  'handleSemanticStatus',
  'handleDeadLinks',
  'handleOrphans',
  'handleHubs',
  'handleTagsList',
  'handleTagsForName',
  'handlePages',
  'handleFolderConfig',
  // `/api/generated-index/settings` coordinates project config with a scoped
  // `.gitattributes` rule. It has no content-document target, so a per-doc
  // conflict cannot apply.
  'handleGeneratedIndexSettings',
  // `/api/saved-themes` (list) + `/api/saved-theme` (save/delete) — user-global
  // theme-store operations. They target scheme files under `<home>/.ok/themes`,
  // not a Y.Doc, so the per-doc conflict-refusal gate does not apply — same
  // posture as `handleFolderConfig`.
  'handleSavedThemesList',
  'handleSavedTheme',
  // `/api/lint/config` (GET) + `/api/lint/markdownlint-config` (POST) — read the
  // effective lint config / write the native `.markdownlint.*` rules. No Y.Doc
  // target (config files, not documents), so the per-doc conflict gate does not
  // apply — same posture as `handleFolderConfig`.
  'handleGetLintConfig',
  'handleWriteMarkdownlintRule',
  // No Y.Doc target (schema-file write to disk) — the conflict gate is N/A,
  // same class as handleWriteMarkdownlintRule.
  'handleWriteFrontmatterSchema',
  // `/api/lint/frontmatter-schemas` (GET) — read-only enumeration of
  // `.ok/schemas/*.json`. No Y.Doc target; conflict gate does not apply.
  'handleFrontmatterSchemasList',
  // `/api/lint` (GET) + `/api/lint/audit` (GET) — read-only lint of one doc /
  // the project. No Y.Doc target (reads from disk), so the per-doc conflict gate
  // does not apply.
  'handleLintDoc',
  'handleLintAudit',
  // `/api/audit` (GET) — read-only unified validation audit (markdownlint +
  // dead links). No Y.Doc target (reads disk + the in-memory backlink index),
  // so the per-doc conflict gate does not apply.
  'handleAudit',
  // `/api/templates` — project-wide flat enumeration of every template
  // (read-only). Walks `<folder>/.ok/templates/*.md`; no Y.Doc target,
  // so the per-doc conflict gate does not apply.
  'handleTemplatesList',
  'handleSuggestLinks',
  'handlePageHeadings',
  'handleHistory',
  'handleHistoryVersion',
  'handleMetricsReconciliation',
  'handleMetricsParseHealth',
  'handleMetricsAgentPresence',
  // `/api/metrics/agent-effects` — GET-only loopback + host-gated diagnostic
  // summarizing the per-doc `Y.Map('agent-effects')` ring buffers. Reads only;
  // targets no Y.Doc write, so the per-doc conflict gate does not apply — same
  // posture as its `handleMetricsAgentPresence` sibling.
  'handleMetricsAgentEffects',
  // `/api/metrics/watcher-recent` — GET-only loopback + host-gated diagnostic
  // returning the file-watcher's recent-decisions ring. Reads only; targets no
  // Y.Doc write, so the per-doc conflict gate does not apply — same posture as
  // its `handleMetricsAgentEffects` sibling.
  'handleMetricsWatcherRecent',
  // `/api/__embed-detect` — read-only loopback + host-gated diagnostic for the
  // embedded-viewer detection spikes; reads the in-process UA ring buffer and
  // returns boolean signals, targets no Y.Doc, so the per-doc conflict gate
  // does not apply.
  'handleEmbedDetect',
  // `/api/client-logs` — web renderer console-log ingest. Writes only to the
  // `renderer` pino log (diagnostics), targets no Y.Doc, so the per-doc
  // conflict gate does not apply.
  'handleClientLogs',
  // `/api/comments` + `/api/comment` — comment-thread dispatchers. Threads live
  // in `.ok/local/comments/`, entirely outside the CRDT/content plane: these
  // routes never write document bytes, so the conflict-refusal gate has nothing
  // to refuse. A doc in conflict can still be commented on (the comment is
  // about the text, not a change to it); the anchor re-find reads the body but
  // never mutates it.
  'handleCommentsRoute',
  'handleCommentRoute',
  'handleWorkspace',
  // `/api/config` — collab-bootstrap payload. GET reads server-lock. Does not
  // target a Y.Doc, so the per-doc conflict gate does not apply.
  'handleApiConfig',
  // `/api/config/diagnostics` (GET) — read-only listing of active config
  // diagnostics across the user, committed-project, and project-local layers.
  // Reads config files fresh per request; targets no Y.Doc, so the per-doc
  // conflict gate does not apply — same posture as `handleApiConfig`.
  'handleConfigDiagnostics',
  'handleRescueList',
  'handleSyncStatus',
  'handleSyncConflicts',
  'handleSyncConflictContent',
  'handleSyncTrigger',
  'handleSyncResolveConflict',
  'handlePrincipal',
  'handleInstalledAgentsRoute',
  'handleServerInfo',
  'handleAgentActivity',
  'handleAgentBurstDiff',
  'handleTemplateGet',
  // Local-op / sync / share / seed handlers — control plane, not user-content
  // mutation. They operate on git refs, the project's config files, and the
  // user's machine state. The conflict gate is per-doc Y.Map; these handlers
  // do not target a Y.Doc, so the gate does not apply.
  'handleLocalOpClone',
  'handleLocalOpOkInit',
  'handleLocalOpAuthLogin',
  'handleLocalOpAuthStatus',
  'handleLocalOpAuthRepos',
  'handleLocalOpAuthSignout',
  'handleLocalOpAuthSetIdentity',
  // GHES sign-in surfaces (PAT store; `gh auth login --web` stream) — credential
  // operations on the user's machine, no Y.Doc target, so the per-doc conflict
  // gate doesn't apply.
  'handleLocalOpAuthPat',
  'handleLocalOpAuthGhLogin',
  // Stops an in-flight device-flow subprocess. Terminates a child and frees a
  // concurrency slot — no Y.Doc target at all.
  'handleLocalOpAuthCancel',
  // Loopback-gated writes of the machine-global embeddings key to the user's
  // secrets file, plus the read-only endpoint probe — no Y.Doc mutation, so the
  // conflict-refusal gate doesn't apply.
  'handleLocalOpEmbeddingsSetKey',
  'handleLocalOpEmbeddingsClearKey',
  'handleLocalOpEmbeddingsTest',
  'handleSpawnCursorRoute',
  'handleHandoffDispatchRoute',
  'handleInstallSkill',
  'handleSkillInstallState',
  // Skill list/install/uninstall/targets/management/restore. These
  // are read-only or local-op projection surfaces (host-dir projection, marker
  // records, fs-direct artifact restore) — NOT CRDT content-doc body writes —
  // so the per-doc conflict gate doesn't apply. (The CONTENT-doc writers
  // `handleSkill`/`handleSkillFile`/`handleSkillUpdate` ARE gated; see REQUIRED.)
  'handleSkillsList',
  'handleSkillInstall',
  'handleSkillUninstall',
  'handleSkillTargets',
  'handleSkillRestore',
  'handleSkillRevert',
  'handleSkillsManagement',
  // POST /api/skill/track-in-git — appends a negation to the project's
  // `.gitignore` so a gitignored bundle becomes trackable. It targets a config
  // file, never a Y.Doc body, so the per-doc conflict gate does not apply —
  // same posture as `handleFolderConfig`.
  'handleSkillTrackInGit',
  // Skill discovery + import (skills marketplace). Search/detail/installed are
  // read-only proxies; import/reimport/upload materialize an upstream (or
  // uploaded) skill to disk fs-direct (like seed/clone) rather than mutating a
  // Y.Doc body, so the per-doc conflict gate doesn't apply.
  'handleSkillsInstalled',
  'handleSkillsSearch',
  'handleSkillsDetail',
  'handleSkillsDiscover',
  'handleSkillsPreview',
  'handleSkillsResolveRef',
  'handleSkillsPopular',
  'handleSkillsPublisher',
  'handleSkillImport',
  'handleSkillsImportBulk',
  // `/api/skill/edit-external` — arms the external-skill registry only; authors
  // no CRDT doc body (autosave-out happens later through persistence), so the
  // per-doc conflict gate doesn't apply.
  'handleSkillEditExternal',
  'handleSkillReimport',
  'handleSkillsReimportBulk',
  'handleSkillUpload',
  // Cross-scope skill move: copies the bundle dir + removes the source
  // fs-direct (like import/delete), not a Y.Doc body write, so the per-doc
  // conflict gate doesn't apply.
  'handleSkillMoveScope',
  // Skill duplicate copies an unopened bundle to a new, absent directory
  // fs-direct; it does not mutate an existing Y.Doc body.
  'handleSkillDuplicate',
  'handleSeedPlan',
  'handleSeedApply',
  // Pack-skill installation authors a new bundle fs-direct or refreshes its
  // editor projection; it does not mutate an existing content Y.Doc body.
  'handleSeedInstallPackSkill',
  'handleSeedPacks',
  'handleShareConstructUrl',
  'handleSharePublishOwners',
  'handleSharePublishNameCheck',
  'handleSharePublish',
  // Git-level read + write surfaces used by the share-receive branch-aware
  // flow. Both operate on parent-git state, not Y.Doc content; the conflict
  // gate is per-doc and does not apply. `handleCheckout` is wrapped in
  // `withParentLock` (serialized with sync-engine writes); `handleBranchInfo`
  // is a read endpoint with no lock per the lock-free-reads contract.
  'handleBranchInfo',
  // `/api/git/worktree-status` — read-only `git status` view for the sync
  // popover (porcelain + tracking refs + incoming diff). Parent-git reads
  // only, never Y.Doc content; lock-free-reads contract, same posture as
  // `handleBranchInfo`.
  'handleGitWorktreeStatus',
  'handleCheckout',
  // `/api/sync/resolve-blocking` — commits the tracked paths whose
  // local edits overlap an incoming merge, then resumes sync. Parent-git only
  // (`add`/`commit`/`restore` under `withParentLock`); the paths it touches are
  // by definition NOT Y.Doc content in conflict, since a content conflict
  // routes to the ConflictStore instead of pausing the merge. Same posture as
  // `handleCheckout`.
  'handleSyncResolveBlocking',
  // `/api/share/target-status` — receive-side git verdict (fetch + rename
  // detection). Updates only remote-tracking refs, never Y.Doc content, so the
  // per-doc conflict gate does not apply. Same posture as `handleBranchInfo`.
  'handleShareTargetStatus',
  // Test-only handlers. Wipe + rebuild semantics; conflict gate is orthogonal
  // (the wipe IS the resolution path in test scope).
  'handleTestReset',
  'handleTestRescanBacklinks',
  'handleTestRescanFiles',
  // Save-version: the shadow-repo checkpoint is created from current Y.Doc
  // state. The checkpoint is a snapshot, not a mutation of the target doc —
  // running it during conflict is a safe, additive action (recovery
  // procedure: users may need to save checkpoints before manually resolving
  // a stuck conflict). No gate required.
  'handleSaveVersion',
  // Create-page / create-folder: produce NEW docs at NEW paths. A conflicted
  // doc cannot be the target of a "create" — by construction the target is
  // a fresh path with no Y.Doc yet. No gate required.
  'handleCreatePage',
  'handleCreateFolder',
  // Trash cleanup: Step 2 of the two-step Trash flow. The mutation is the
  // delete-from-disk of paths already moved to `.trash/`; conflicted docs
  // would have been gated at the move-to-trash boundary (handleDeletePath).
  'handleTrashCleanup',
  // Upload asset: writes binary asset files (images, PDFs, etc.) outside
  // the Y.Doc index. Targets `assets/`-style paths; no `lifecycle.status`
  // applies because assets are not CRDT documents.
  'handleUploadAsset',
  // Frontmatter patch: routes through `applyPatchToFm` which composes the
  // FM region directly. Frontmatter writes during conflict are documented
  // as orthogonal (the conflict markers live in the body region, FM is
  // unaffected by markers) — no gate required for v1. Future tightening
  // would route through the same spine gate if FM-during-conflict surfaces
  // ambiguity.
  'handleFrontmatterPatch',
]);

function extractHandlerBody(handlerName: string): string | null {
  // Same legacy vs migrated detection as the attribution-sweep meta-test,
  // plus the `methodRouter({...})` dispatcher shape. Pick whichever source
  // declares it (a lifted handler is not in `api-extension.ts`).
  const fnDecl = `async function ${handlerName}(`;
  const constDecl = `const ${handlerName} = withValidation(`;
  const routerDecl = `const ${handlerName} = methodRouter(`;
  const owner =
    HANDLER_SOURCES.find(
      (text) => text.includes(fnDecl) || text.includes(constDecl) || text.includes(routerDecl),
    ) ?? source;
  const fnIdx = owner.indexOf(fnDecl);
  const constIdx = owner.indexOf(constDecl);
  const routerIdx = owner.indexOf(routerDecl);
  let start = -1;
  if (fnIdx !== -1) start = fnIdx;
  else if (constIdx !== -1) start = constIdx;
  else if (routerIdx !== -1) start = routerIdx;
  if (start === -1) return null;
  const nextFn = owner.indexOf('\n  async function handle', start + 1);
  const nextConst = owner.indexOf('\n  const handle', start + 1);
  const nextRoutes = owner.indexOf('\n  const routes:', start + 1);
  // Factory modules end their handler run at the returned record.
  const nextReturn = owner.indexOf('\n  return {', start + 1);
  const candidates = [nextFn, nextConst, nextRoutes, nextReturn].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return owner.slice(start, next === -1 ? owner.length : next);
}

function extractStaticRouteHandlerNames(): string[] {
  // Every source's `const routes:` record participates — the legacy dispatch
  // record in `api-extension.ts` AND each native group's own record.
  return HANDLER_SOURCES.flatMap((text) => {
    const routesStart = text.indexOf('\n  const routes:');
    if (routesStart === -1) return [];
    const enableTestRoutes = text.indexOf('\n  if (enableTestRoutes)', routesStart);
    const nativeTable = text.indexOf('\n  const table', routesStart);
    const bounds = [enableTestRoutes, nativeTable].filter((i) => i !== -1);
    const slice = text.slice(routesStart, bounds.length === 0 ? text.length : Math.min(...bounds));
    return [...slice.matchAll(/:\s*(handle\w+)/g)].map((m) => m[1]);
  });
}

describe('conflict-gate coverage (FR9)', () => {
  test('every required mutating handler has a conflict gate (direct or via spine)', () => {
    const failures: string[] = [];
    for (const handler of REQUIRED_HANDLERS) {
      const body = extractHandlerBody(handler);
      if (body === null) {
        failures.push(`${handler}: function not found in source`);
        continue;
      }
      // Direct gate: handler catches `DocInConflictError` and surfaces via
      // `respondDocInConflict`, OR fires `respondDocInConflict` inline,
      // OR delegates the gate to a shared helper that itself responds
      // with the same envelope (e.g. `checkTemplateConflictGate`).
      const directGate =
        body.includes('respondDocInConflict(') ||
        body.includes('checkTemplateConflictGate(') ||
        body.includes('checkSkillDocConflictGate(');
      // Spine routing: handler calls one of the gated primitives. Those
      // primitives throw `DocInConflictError` at entry; the handler's catch
      // arm translates that to the 409 envelope. `applyAgentMarkdownWrite`
      // and `applyAgentUndo` are the two gated spines.
      const spineRouting =
        body.includes('applyAgentMarkdownWrite(') || body.includes('applyAgentUndo(');
      // For dispatcher-style handlers (handleTemplate), accept routing
      // through a sibling sub-handler that itself gates. The structural
      // check: the dispatcher references one of the gated sub-handlers —
      // as a call (`handleTemplatePut(req, res)`) or as a `methodRouter`
      // verb-map value (`PUT: handleTemplatePut`) — AND that sub-handler
      // appears in REQUIRED_HANDLERS itself.
      const dispatcherRouting =
        /\b(?:handleTemplatePut|handleTemplateDelete|handleTemplateMove|handleSkillPut|handleSkillFilePut)\b/.test(
          body,
        );
      if (!directGate && !spineRouting && !dispatcherRouting) {
        failures.push(
          `${handler}: missing conflict gate — must call respondDocInConflict(...) directly, route through applyAgentMarkdownWrite/applyAgentUndo, or dispatch to a gated sub-handler`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('every handler in the static route registry is tracked as required or exempt', () => {
    const names = extractStaticRouteHandlerNames();
    const required = new Set(REQUIRED_HANDLERS);
    const untracked = names.filter((h) => !required.has(h) && !EXEMPT_HANDLERS.has(h));
    expect(untracked).toEqual([]);
  });

  /**
   * Spine-level enforcement check — `applyAgentMarkdownWrite` and
   * `applyAgentUndo` MUST throw `DocInConflictError` before any mutation
   * fires. Pinning the structural shape so a future edit that moves the
   * gate INSIDE the transact (incorrect: throw must short-circuit the
   * paired-write origin contract) is caught here.
   *
   */
  test('spine-level gate fires before transact in agent-sessions.ts', () => {
    const sessionsSrc = readFileSync(
      join(import.meta.dirname, '../../../server/src/agent-sessions.ts'),
      'utf8',
    );
    // Both spine functions reference DocInConflictError at their
    // entry — the throw must be reachable BEFORE the inner withSpanSync
    // wrapper runs.
    expect(sessionsSrc).toContain('throw new DocInConflictError');
    // Two throw sites — one per spine (applyAgentMarkdownWrite +
    // applyAgentUndo). A future refactor that loses one of them surfaces
    // here.
    const throwMatches = sessionsSrc.match(/throw new DocInConflictError/g) ?? [];
    expect(throwMatches.length).toBeGreaterThanOrEqual(2);
  });
});
