/**
 * Attribution sweep meta-test — static analysis gate.
 *
 * Asserts: (1) every mutating POST handler in api-extension.ts threads
 * identity at entry (via either `extractAgentIdentity` for agent-write
 * handlers or `extractActorIdentity` for rename + rollback); (2) no new
 * POST handler can be added to the route registry without being explicitly
 * tracked here; (3) `extract-actor-identity.ts` never reads body-supplied
 * `principalId` — server's `getPrincipal()` is the sole source (HTTP body
 * is unauthenticated; structurally enforcing the trust boundary).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');
const ACTOR_HELPER_PATH = join(
  import.meta.dirname,
  '../../../server/src/extract-actor-identity.ts',
);
const actorHelperSource = readFileSync(ACTOR_HELPER_PATH, 'utf8');

/** Mutating POST handlers that must call extractAgentIdentity.
 *
 * Frontmatter writes from the property panel intentionally do NOT appear
 * here — they bypass HTTP entirely and reach `Y.Map('metadata')` through
 * `bindFrontmatterDoc.patch()` under `FORM_WRITE_ORIGIN`. Attribution
 * comes from the WebSocket connection's `ctx.principalId`, resolved by
 * `resolveWriterFromOrigin` in `persistence.ts`. The HTTP-handler scan
 * here doesn't see those writers — that's expected.
 */
const REQUIRED_HANDLERS = [
  'handleAgentWrite',
  'handleAgentWriteMd',
  'handleAgentPatch',
  // Per-key frontmatter mutation via JSON Merge Patch. Writes through the same
  // session-frozen origin as the other agent-write handlers; attribution is
  // threaded identically.
  'handleFrontmatterPatch',
  'handleAgentUndo',
  'handleSaveVersion',
  'handleRollback',
  'handleCreatePage',
  'handleCreateFolder',
  'handleRenamePath',
  'handleDeletePath',
  'handleDuplicatePath',
  // `handleTrashCleanup` — Step 2 of the two-step Trash flow.
  // Mutating: closes Hocuspocus docs, purges the file index,
  // marks recentlyRemovedDocs, broadcasts CC1 files. Uses extractActorIdentity
  // for audit-trail consistency with rename + rollback.
  'handleTrashCleanup',
  // Single unified upload handler — `/api/upload` (accept-all by extension).
  // The per-MIME `handleUploadVideo` / `handleUploadAudio` shape was retired
  // in favor of one handler, one identity
  // call site. Renamed handleUploadImage → handleUploadAsset
  // because the route is no longer image-specific after the upload unification.
  'handleUploadAsset',
  // `/api/skill/update` — refresh an installed starter-pack skill from OK's
  // bundled source. A mutating CRDT content-doc write (composeAndWriteRawBody
  // through the project skill content doc), so it threads identity at entry
  // (extractActorIdentity for the timeline + extractAgentIdentity for the
  // session) like the other content-write handlers.
  'handleSkillUpdate',
];

/**
 * Handlers exempt from identity threading: GET-only endpoints, test utilities,
 * local-op handlers whose callers are not agents, and sync orchestrator
 * handlers where the HTTP boundary is control-plane only — the actual commits
 * they produce come from the SyncEngine internally and are already attributed
 * via classified writers (git-upstream, file-system, openknowledge-service).
 */
const EXEMPT_HANDLERS = new Set([
  'handleDocumentRead',
  'handleDocumentList',
  // `/api/__embed-detect` — read-only loopback + host-gated diagnostic
  // (embedded-viewer detection spike); reads the UA ring buffer and performs
  // no writes, so there is nothing to attribute.
  'handleEmbedDetect',
  'handleAsset',
  // Sibling read-only handler for the editor's `TextViewer` ("View as
  // text"). Same exemption posture as `handleAsset`:
  // it's a path-safety-gated, ignore-filter-honoring file read with no
  // mutating side effects, so it doesn't need agent-identity attribution.
  'handleAssetText',
  'handleBacklinks',
  'handleBacklinkCounts',
  'handleForwardLinks',
  'handleLinkGraph',
  'handleSearch',
  // GET /api/semantic-status — read-only setup/coverage probe for the Settings
  // → Search panel (enabled / capable / embedded / total). No mutation and no
  // agent content; same exemption posture as handleSearch / handleServerInfo.
  'handleSemanticStatus',
  'handleDeadLinks',
  'handleOrphans',
  'handleHubs',
  // `/api/tags` + `/api/tags/:name` — read-only tag index lookups.
  'handleTagsList',
  'handleTagsForName',
  'handlePages',
  // `/api/folder-config` + `/api/template` — folder cascade + templates
  // management (GET reads, PUT upserts, DELETE removes `.ok/` config files).
  // These are project-configuration writes (folder defaults, template
  // definitions), not agent-authored document content — same rationale as
  // seed/sync/local-op handlers. No agent identity needed.
  'handleFolderConfig',
  'handleTemplate',
  // `/api/templates` — project-wide flat enumeration of every template
  // (read-only). Returns the union of all `<folder>/.ok/templates/*.md`;
  // same rationale as `handleTagsList` — read path, no agent identity.
  'handleTemplatesList',
  // `/api/skill` (dispatcher) + `/api/skills` (read-only list) — `.ok/skills/`
  // artifact management. Same posture as `handleTemplate` /
  // `handleTemplatesList`: project-configuration artifacts (agent-skill
  // definitions), not agent-authored document content. The mutating
  // sub-handlers (`handleSkillPut` / `handleSkillDelete` / `handleSkillMove`)
  // DO thread `extractActorIdentity` for the folder timeline, but the
  // route-registry entry is the dispatcher, which is exempt by the same
  // project-config rationale as templates.
  'handleSkill',
  // `/api/skill-file` (dispatcher) — GET reads one bundle file; the mutating
  // PUT/DELETE sub-handlers (`handleSkillFilePut` / `handleSkillFileDelete`)
  // thread `extractActorIdentity` + `extractAgentIdentity` themselves. The
  // route-registry entry is the dispatcher, exempt by the same rationale as
  // `handleSkill` / `handleTemplate`.
  'handleSkillFile',
  'handleSkillsList',
  // `/api/skill/install` — projects a skill's source into editor host dirs on
  // this machine. A local-op projection (writes `.{host}/skills/`, OUTSIDE the
  // content/CRDT plane), not an attributed content mutation — the SOURCE edit
  // (write/edit({skill})) is what's attributed. Same posture as the other
  // local-op handlers (clone/open/install-skill/seed).
  'handleSkillInstall',
  // `/api/skill/uninstall` — reverse-projection + marker removal (demote to
  // Draft). Local-op like install; the SOURCE edit is what's attributed.
  'handleSkillUninstall',
  // `/api/skill-targets` — GET reads / PUT sets the committed project
  // skill-target set + re-projects managed skills. A user/UI project-config
  // action (local-op projection), not agent-authored content; same exempt
  // posture as `handleSkillInstall`.
  'handleSkillTargets',
  // `/api/skills/management` — GET reads / PUT records the per-machine
  // project-managed opt-in + runs the import reconcile (local-op projection).
  // A user/UI project-config action, not agent-authored content; same exempt
  // posture as `handleSkillTargets`.
  'handleSkillsManagement',
  // `/api/skill/restore` (fs-direct restore of a `.ok/skills/` artifact). Same
  // project-config posture as the other skill handlers — restore threads
  // `extractActorIdentity` to attribute the new version, but the artifact is
  // config, not agent-authored doc content.
  'handleSkillRestore',
  'handleSuggestLinks',
  'handlePageHeadings',
  'handleHistory',
  'handleHistoryVersion',
  'handleMetricsReconciliation',
  'handleMetricsParseHealth',
  'handleMetricsAgentPresence',
  // `/api/client-logs` — web/browser renderer console-log ingest. Writes only
  // to the `renderer` pino log (diagnostics), no Y.Docs / agent content; gated
  // by `checkLocalOpSecurity` like the local-op handlers. No identity needed.
  'handleClientLogs',
  'handleWorkspace',
  'handleRescueList',
  'handleSyncStatus',
  'handleSyncConflicts',
  'handleSyncConflictContent',
  'handleSyncTrigger',
  'handleSyncResolveConflict',
  'handleLocalOpClone',
  'handleLocalOpOkInit',
  'handleLocalOpAuthLogin',
  'handleLocalOpAuthStatus',
  'handleLocalOpAuthRepos',
  'handleLocalOpAuthSignout',
  'handleLocalOpAuthSetIdentity',
  // POST /api/local-op/embeddings/{set-key,clear-key} — loopback-gated writes of
  // the machine-global embeddings key to ~/.ok/secrets.yml. Operate on the local
  // user's credential file, not agent-authored content — same rationale as the
  // sibling local-op auth handlers. No agent identity to thread.
  'handleLocalOpEmbeddingsSetKey',
  'handleLocalOpEmbeddingsClearKey',
  'handleTestReset',
  // POST /api/test-flush-git — test-routes-only L2 git-flush drain; mutates
  // no document content (commits what persistence already wrote), so there
  // is no agent identity to thread. Same posture as handleTestReset.
  'handleTestFlushGit',
  'handlePrincipal',
  'handleInstalledAgentsRoute',
  // GET /api/server-info — identity-free readonly endpoint surfacing the
  // per-process serverInstanceId for CRDT restart-recovery defense.
  'handleServerInfo',
  // `/api/config` — collab-bootstrap payload. GET reads server-lock + armed
  // pane-target; DELETE clears the local pane-target TTL file. No Y.Doc
  // mutation and no agent content, so identity threading is exempt — same
  // rationale as `handleServerInfo`.
  'handleApiConfig',
  // `ok seed` scaffolder endpoints. Operate on project-level
  // folder structure on behalf of the local user, not agent content — same
  // rationale as sync/local-op handlers. `handleSeedPacks` is a static-data
  // GET (enumerates registered packs from `STARTER_PACKS`); identity-free.
  'handleSeedPlan',
  'handleSeedApply',
  'handleSeedPacks',
  'handleAgentActivity',
  'handleAgentBurstDiff',
  // `/api/install-skill` — local-op style endpoint guarded by
  // `checkLocalOpSecurity`. Builds `openknowledge.skill` and hands off to
  // the OS file association (Claude Desktop). Operates on the user's
  // ~/Downloads folder on behalf of the local user, not agent content —
  // same rationale as sync/local-op/seed handlers.
  'handleInstallSkill',
  // `/api/skill/install-state` — read-only GET against `~/.ok/skill-state/`.
  // No mutation, no agent content. Same rationale as `handleServerInfo`.
  'handleSkillInstallState',
  // `/api/spawn-cursor` — loopback-only POST that spawns the `cursor` CLI
  // on the user's machine for the Open-in-Cursor handoff. Same rationale as
  // local-op / sync / seed handlers: the operation is on behalf of the
  // local user, no agent content is authored, and the security boundary is
  // `checkLocalOpSecurity` (loopback + Host-header + path containment +
  // hardcoded binary). See `packages/server/src/spawn-cursor-api.ts`.
  'handleSpawnCursorRoute',
  // `/api/handoff` — loopback-only POST that owns the full Open-in-Agent
  // recipe per target (Claude / Codex via `open -a` + URL; Cursor via
  // `cursor <path>` + URL). Same rationale as `/api/spawn-cursor`: local-user
  // operation, no agent content is authored, security boundary is
  // `checkLocalOpSecurity` (loopback + Host-header) plus per-recipe
  // allowlists (app-name, URL scheme, path containment). See
  // `packages/server/src/handoff-dispatch-api.ts`.
  'handleHandoffDispatchRoute',
  // `/api/share/construct-url` — loopback-only POST that reads the project's
  // local git state (HEAD branch, `[remote "origin"] url`, packed/loose
  // origin/<branch> refs) and emits a marketing-safe share URL. Read-only
  // against the working tree — no commits, no pushes, no
  // identity threading required. Same rationale as local-op/sync/seed
  // handlers; security boundary is `checkLocalOpSecurity`. See
  // `packages/server/src/share/construct-url.ts`.
  'handleShareConstructUrl',
  // `/api/share/publish/*` — loopback-only Publish-to-GitHub wizard endpoints.
  // All three spawn the `open-knowledge share <sub>`
  // CLI subprocess; the heavy lifting (Octokit + simple-git) lives in the
  // CLI workspace where the token-store lives. Security boundary is
  // `checkLocalOpSecurity`; no agent identity threading required (the
  // operation is a local-user action, not agent-authored content). Same
  // rationale as local-op/auth/* + handleShareConstructUrl.
  'handleSharePublishOwners',
  'handleSharePublishNameCheck',
  'handleSharePublish',
  // `/api/git/branch-info` — read-only GET against the project's git
  // working tree (HEAD identity, `git cat-file -e`, dirty-tree overlap,
  // `rev-parse --verify`). Powers the share-receive branch-switch dialog.
  // No CRDT mutation, no agent-authored content; same rationale as
  // `handleSyncStatus` / `handleServerInfo`.
  'handleBranchInfo',
  // `/api/git/checkout` — git-level operation, no CRDT mutation. Wrapped
  // in `withParentLock` to serialize against the sync-engine's parent-git
  // writes; the HEAD watcher handles the CRDT transition asynchronously.
  // Identity is still extracted at entry for observability, but the
  // operation never touches Y.Docs so identity threading is exempt.
  'handleCheckout',
  // `/api/share/target-status` — receive-side git verdict (targeted fetch +
  // `cat-file -e` / removal-commit lookup / rename detection). Updates only
  // remote-tracking refs, no CRDT mutation, no agent-authored content; same
  // rationale as `handleBranchInfo` / `handleCheckout`.
  'handleShareTargetStatus',
]);

function extractHandlerBody(handlerName: string): string | null {
  // Legacy shape: `async function handle...(`. Migrated shape:
  // `const handle... = withValidation(...)`. Both must be supported as the
  // cluster migrations land. Pick whichever appears first in the file.
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
  // Bound the last handler at the route table so the onRequest extension
  // body (which uses `errorResponse(...)` for the /api/* Origin gate) is
  // never folded into the handler slice.
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

describe('attribution sweep coverage (FR-5, D42)', () => {
  test('all required POST handlers call an identity-threading helper', () => {
    // Identity threading is satisfied by either `extractAgentIdentity` (used
    // by agent-write handlers) OR `extractActorIdentity` (used by rename +
    // rollback handlers; routes agent identity OR principal-fallback).
    const failures: string[] = [];
    for (const handler of REQUIRED_HANDLERS) {
      const body = extractHandlerBody(handler);
      if (body === null) {
        failures.push(`${handler}: function not found in source`);
        continue;
      }
      if (!body.includes('extractAgentIdentity(') && !body.includes('extractActorIdentity(')) {
        failures.push(`${handler}: missing extractAgentIdentity or extractActorIdentity call`);
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

  test('extract-actor-identity.ts never reads body-supplied principalId (D-A11 trust boundary)', () => {
    // Strip comments + JSDoc so the structural check only inspects executable code.
    const code = actorHelperSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/body\s*[.[][^a-zA-Z0-9_]*['"]?principalId/.test(code)).toBe(false);
  });

  // For every mutating handler migrated to the RFC 9457 envelope, semantic
  // `errorResponse(...)` calls MUST happen AFTER identity extraction (via
  // either `extractAgentIdentity` for agent-write handlers or
  // `extractActorIdentity` for rename + rollback handlers). Body-shape
  // failures routed through `validateBody` are anonymous (semantically OK —
  // no Y.Doc mutation attempted) and are excluded from the ordering check.
  // The policy is documented in `packages/server/src/http/README.md`.
  //
  // The check is gated on the migrated handler being present and on it
  // calling `errorResponse`. Pre-migration handlers (still using inline
  // `json(res, NNN, { ok: false, ... })`) are skipped.
  test('migrated mutating handlers extract identity before any semantic errorResponse', () => {
    const failures: string[] = [];
    for (const handler of REQUIRED_HANDLERS) {
      const body = extractHandlerBody(handler);
      if (body === null) continue;
      if (!body.includes('errorResponse(')) continue; // pre-migration; skip
      // Anchor on the FIRST identity extraction in the handler body. A handler
      // may call BOTH helpers (e.g. `extractActorIdentity` at entry for the
      // audit-trail actor, then `extractAgentIdentity` later for the write
      // session) — once the first identity call lands, every subsequent
      // semantic error is post-identity by construction, so the EARLIER index
      // is the correct ordering anchor (a `Math.max` would mis-flag a genuine
      // semantic error sitting between the two calls).
      const agentIdx = body.indexOf('extractAgentIdentity(');
      const actorIdx = body.indexOf('extractActorIdentity(');
      const presentIdxs = [agentIdx, actorIdx].filter((i) => i !== -1);
      const identityIdx = presentIdxs.length === 0 ? -1 : Math.min(...presentIdxs);
      if (identityIdx === -1) continue; // already failed by the prior test

      // Find the FIRST `errorResponse(` call. If it precedes the identity
      // extraction it MUST be a body-shape error (i.e. the catch block that
      // follows readUploadBody / inside validateBody) — those emissions are
      // pre-identity by policy. Heuristic: a `validateBody(` call earlier
      // in the function is fine; a bare `errorResponse(` not wrapped by
      // `if (e instanceof UploadWriteError)` style guarding is suspicious.
      // We approximate by scanning text between `errorResponse(` and
      // identityIdx for the surrounding context.
      const firstErrorIdx = body.indexOf('errorResponse(');
      if (firstErrorIdx > identityIdx) continue; // post-identity already
      // pre-identity emit detected — verify it sits inside body-shape paths:
      // a `catch` of body parsing, or a `validateBody(` call site, or after
      // a raw method-not-allowed early-return at the top of the function.
      // These are the recognized pre-identity emission contexts.
      const preIdentityRegion = body.slice(0, identityIdx);
      const allErrorEmitsPreIdentity = [...preIdentityRegion.matchAll(/errorResponse\(/g)].map(
        (m) => m.index ?? 0,
      );
      const bodyShapeContexts = [
        /method-not-allowed/, // top-of-handler method check
        /malformed-upload/, // body-parse failure
        /invalid-request/, // validateBody auto-emit
        /storage-/, // upload streaming pipeline failure pre-identity
      ];
      const allBodyShape = allErrorEmitsPreIdentity.every((idx) => {
        // Inspect ~500 chars of context around the emit to confirm it is a
        // body-shape error. Conservative: any of the allowlisted URN
        // tokens within the surrounding window passes.
        const context = body.slice(Math.max(0, idx - 100), Math.min(body.length, idx + 400));
        return bodyShapeContexts.some((re) => re.test(context));
      });
      if (!allBodyShape) {
        failures.push(
          `${handler}: pre-identity errorResponse(...) emit is not a recognized body-shape error context — semantic errors must be post-identity-extraction per precedent #24`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
