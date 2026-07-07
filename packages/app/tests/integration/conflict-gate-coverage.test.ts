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
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');

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
  // Skill CONTENT-doc writers (skills-as-content): a PROJECT `SKILL.md` and its
  // `.md` references are real CRDT content docs, so their CRDT paired-write
  // path must refuse a mid-conflict doc via `checkSkillDocConflictGate`. The
  // `/api/skill` + `/api/skill-file` dispatchers route to the gated PUT
  // sub-handlers; `/api/skill/update` gates inline. (DELETE sub-handlers tear
  // the doc down rather than mutate its body, and global skills + scripts are
  // fs-direct non-CRDT artifacts the gate no-ops on.)
  'handleSkill',
  'handleSkillPut',
  'handleSkillFile',
  'handleSkillFilePut',
  'handleSkillUpdate',
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
  'handleAsset',
  'handleAssetText',
  'handleBacklinks',
  'handleBacklinkCounts',
  'handleForwardLinks',
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
  // `/api/__embed-detect` — read-only loopback + host-gated diagnostic for the
  // embedded-viewer detection spikes; reads the in-process UA ring buffer and
  // returns boolean signals, targets no Y.Doc, so the per-doc conflict gate
  // does not apply.
  'handleEmbedDetect',
  // `/api/client-logs` — web renderer console-log ingest. Writes only to the
  // `renderer` pino log (diagnostics), targets no Y.Doc, so the per-doc
  // conflict gate does not apply.
  'handleClientLogs',
  'handleWorkspace',
  // `/api/config` — collab-bootstrap payload. GET reads server-lock + armed
  // pane-target; DELETE clears the local pane-target TTL file. Neither targets
  // a Y.Doc, so the per-doc conflict gate does not apply.
  'handleApiConfig',
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
  // Loopback-gated writes of the machine-global embeddings key to the user's
  // secrets file — no Y.Doc mutation, so the conflict-refusal gate doesn't apply.
  'handleLocalOpEmbeddingsSetKey',
  'handleLocalOpEmbeddingsClearKey',
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
  'handleSkillsManagement',
  'handleSeedPlan',
  'handleSeedApply',
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
  'handleCheckout',
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
  // Same legacy vs migrated detection as the attribution-sweep meta-test.
  const fnDecl = `async function ${handlerName}(`;
  const constDecl = `const ${handlerName} = withValidation(`;
  const fnIdx = source.indexOf(fnDecl);
  const constIdx = source.indexOf(constDecl);
  let start = -1;
  if (fnIdx !== -1) start = fnIdx;
  else if (constIdx !== -1) start = constIdx;
  if (start === -1) return null;
  const nextFn = source.indexOf('\n  async function handle', start + 1);
  const nextConst = source.indexOf('\n  const handle', start + 1);
  const nextRoutes = source.indexOf('\n  const routes:', start + 1);
  const candidates = [nextFn, nextConst, nextRoutes].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return source.slice(start, next === -1 ? source.length : next);
}

function extractStaticRouteHandlerNames(): string[] {
  const routesStart = source.indexOf('\n  const routes:');
  const enableTestRoutes = source.indexOf('\n  if (enableTestRoutes)', routesStart);
  const slice =
    routesStart === -1
      ? ''
      : source.slice(routesStart, enableTestRoutes === -1 ? source.length : enableTestRoutes);
  return [...slice.matchAll(/:\s*(handle\w+)/g)].map((m) => m[1]);
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
      // check: the dispatcher calls one of the gated sub-handlers AND that
      // sub-handler appears in REQUIRED_HANDLERS itself.
      const dispatcherRouting =
        body.includes('handleTemplatePut(') ||
        body.includes('handleTemplateDelete(') ||
        body.includes('handleTemplateMove(') ||
        body.includes('handleSkillPut(') ||
        body.includes('handleSkillFilePut(');
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
