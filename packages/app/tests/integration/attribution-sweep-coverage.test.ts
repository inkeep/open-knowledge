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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');
/**
 * Handlers and route records no longer all live in `api-extension.ts`: lifted
 * groups (`skills-sh-handlers.ts`, and native Wave 2 groups like
 * `http/link-graph-routes.ts`, which carry their OWN `const routes:` record)
 * must stay inside the sweep, mirroring `error-envelope-coverage.test.ts` —
 * otherwise a mutating handler added to a lifted file would ship without a
 * categorization decision.
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
  // Batch sibling of handleAgentWriteMd — one identity extraction attributes
  // every entry in the batch; per-entry failures are response-body results,
  // not wire-level errorResponse emits, so the ordering check sees only the
  // post-identity catch-all.
  'handleAgentWriteBatch',
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
  // `/api/skill/import` — acquire a skill into `.ok/skills` as content. A
  // mutating write through the same content writers an authored skill uses
  // (`applySkillWrite` + `applySkillBundleFileWrite`), so it threads identity
  // at entry (`extractActorIdentity`) and shadow-commits the project artifact.
  'handleSkillImport',
  // `/api/skills/import-bulk` — the same acquisition spine as
  // `/api/skill/import`, run once per selected skill against a single clone, so
  // it threads identity at entry exactly the same way.
  'handleSkillsImportBulk',
  // `/api/skill/reimport` — refresh an imported skill from its recorded
  // upstream (`.ok/skills-lock.json`). Re-fetches and rewrites the skill via
  // the same content writers as import, so it threads identity at entry
  // (`extractActorIdentity`) like `handleSkillImport`.
  'handleSkillReimport',
  // `/api/skill-upload` — materialize an uploaded skill archive into
  // `.ok/skills` via the shared `finishSkillImport` spine (the same content
  // writers as import), so it threads identity at entry (`extractActorIdentity`)
  // like `handleSkillImport`.
  'handleSkillUpload',
  // `/api/skill/move-scope` — relocate a skill across scopes (project ↔ global).
  // Copies the bundle verbatim + removes the source in one atomic op; the
  // project-scope side is shadow-committed, so it threads identity at entry
  // (`extractActorIdentity`) like the other mutating skill handlers.
  'handleSkillMoveScope',
  // `/api/skill/duplicate` — copy a complete skill bundle under a new project
  // artifact identity. Project copies are shadow-committed, so attribution is
  // extracted at the route boundary like import and cross-scope move.
  'handleSkillDuplicate',
  // `/api/lint/fix` — apply markdownlint's auto-fixes to a document through the
  // agent-write spine (applyAgentMarkdownWrite). A mutating CRDT content-doc
  // write, so it threads extractAgentIdentity at entry to attribute the fix to
  // the calling agent (never the anonymous `file-system` writer a shell
  // `ok lint --fix` produces).
  'handleLintFix',
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
  // GET /api/acp/catalog — read-only ACP agent-catalog listing (registry +
  // custom entries); performs no writes, so there is nothing to attribute.
  // Agent-thread writes flow through the /collab/thread WS and are attributed
  // per-session there (agent-<id> writer taxonomy), not via this route.
  'handleAcpCatalog',
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
  // GET /api/comment-counts — read-only count lookup over the comment index.
  // It creates and edits nothing, so there is no authorship to attribute; the
  // thread mutations that DO need identity go through `/api/comment`'s
  // `extractActorIdentity` boundary.
  'handleCommentCounts',
  'handleForwardLinks',
  // POST /api/link-preview — read-only external metadata fetch for the editor
  // hover card. No Y.Doc / vault mutation and no agent-authored content; its
  // access control is the route's own anti-proxy gate plus the SSRF guard, not
  // agent-identity attribution.
  'handleLinkPreview',
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
  // `/api/saved-themes` (list) + `/api/saved-theme` (save/delete) — user-global
  // theme-store operations. They write scheme files under `<home>/.ok/themes`,
  // not agent-authored CRDT document content, so there is no authorship to
  // attribute — same rationale as `handleFolderConfig` / the local-op handlers.
  'handleSavedThemesList',
  'handleSavedTheme',
  'handleTemplate',
  // `/api/lint/config` (GET) + `/api/lint/markdownlint-config` (POST) — the markdown
  // linter's effective-config read and the native `.markdownlint.*` rule write.
  // Project-configuration writes (lint rules), not agent-authored document
  // content — same rationale as `handleFolderConfig`. No agent identity needed.
  'handleGetLintConfig',
  'handleWriteMarkdownlintRule',
  // Project-config write (frontmatter schema file), not agent-authored content —
  // same class as handleWriteMarkdownlintRule.
  'handleWriteFrontmatterSchema',
  // `/api/lint/frontmatter-schemas` (GET) — read-only enumeration of the
  // project's `.ok/schemas/*.json` files for the mapping picker. No writes.
  'handleFrontmatterSchemasList',
  // `/api/lint` (GET) + `/api/lint/audit` (GET) — read-only lint of a single doc
  // / the whole project. No writes, no agent identity — same rationale as the
  // other read handlers below.
  'handleLintDoc',
  'handleLintAudit',
  // `/api/audit` (GET) — read-only unified validation audit (markdownlint +
  // dead links) over the project or a sub-path. No writes, no agent identity —
  // same rationale as `handleLintAudit`.
  'handleAudit',
  // `/api/template/import` — imports an existing doc as a template. Same
  // project-config posture as `handleTemplate`; it DOES thread
  // `extractActorIdentity` (folder timeline) + `extractAgentIdentity` (template
  // write session), but is exempt from the identity-required sweep because the
  // single-file-mode guard emits before identity extraction — same rationale as
  // the sibling template handlers.
  'handleTemplateImport',
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
  // `/api/skill-file/rename` — moves ONE bundle file; threads
  // `extractActorIdentity` itself (folder timeline) and rides the same
  // project-config posture as its PUT/DELETE siblings.
  'handleSkillFileRename',
  'handleSkillsList',
  // `/api/skills/search` + `/api/skills/detail` — read-only skill-discovery
  // proxies (GET). Search proxies skills.sh with a GitHub-topic fallback;
  // detail enriches one result from the skills.sh page's Open Graph tags.
  // Neither writes, so there is nothing to attribute.
  'handleSkillsSearch',
  'handleSkillsDetail',
  // `/api/skill/edit-external` — arms the external-skill registry (name → real
  // dir) so a detected skill opens as an editable `__extskill__/` buffer. Authors
  // no CRDT content itself; the autosave-out writes happen later through
  // persistence (classified `file-system`). Loopback-gated local-op, same
  // exempt posture as `handleSkillInstall` / `handleInstallSkill`.
  'handleSkillEditExternal',
  // `/api/skills/discover` — read-only peek at a remote source (throwaway
  // shallow clone) enumerating the skills it bundles so Import can offer a
  // picker. Writes nothing to attribute.
  'handleSkillsDiscover',
  // `/api/skills/popular` — read-only Discover blank-state list, scraped from the
  // skills.sh front page + cached. Writes nothing to attribute.
  'handleSkillsPopular',
  // `/api/skills/publisher` — read-only per-publisher listing, scraped from that
  // publisher's skills.sh page + cached, so a caller can rank a list it already
  // has by install count. Writes nothing to attribute.
  'handleSkillsPublisher',
  // `/api/skills/preview` — fetches an un-imported skill's SKILL.md text (via a
  // throwaway shallow clone) so the Explore modal can render it before import.
  // Read-only; writes nothing to attribute.
  'handleSkillsPreview',
  // `/api/skills/resolve-ref` — resolves a skill's `/other-skill` reference by
  // trusted-provenance precedence (local / same-source clone / same-publisher
  // search). Read-only lookup; writes nothing to attribute.
  'handleSkillsResolveRef',
  // `/api/skills/installed` — read-only cross-harness installed-skill
  // enumeration (marketplace slice 1). Reads harness skill dirs + the Claude
  // plugin manifest; performs no writes, so there is nothing to attribute.
  'handleSkillsInstalled',
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
  // `/api/skill/restore` (fs-direct restore of a `.ok/skills/` artifact). Same
  // project-config posture as the other skill handlers — restore threads
  // `extractActorIdentity` to attribute the new version, but the artifact is
  // config, not agent-authored doc content.
  'handleSkillRestore',
  // `/api/skill/revert` (fs-direct restore to the install baseline). Threads
  // `extractActorIdentity` to attribute the revert as a new version, same posture
  // as restore.
  'handleSkillRevert',
  // `/api/skill/track-in-git` (appends a `.gitignore` negation so a gitignored
  // bundle becomes trackable). It rewrites a config file fs-direct and never
  // authors doc content, so there is no contributor to record — same posture as
  // the other project-config skill handlers.
  'handleSkillTrackInGit',
  'handleSuggestLinks',
  'handlePageHeadings',
  'handleHistory',
  'handleHistoryVersion',
  'handleMetricsReconciliation',
  'handleMetricsParseHealth',
  'handleMetricsAgentPresence',
  // `/api/metrics/agent-effects` — GET-only loopback + host-gated diagnostic
  // (per-doc agent-effects ring-buffer summaries). Read path, no writes,
  // nothing to attribute — same posture as `handleMetricsAgentPresence`.
  'handleMetricsAgentEffects',
  // `/api/metrics/watcher-recent` — GET-only loopback + host-gated diagnostic
  // (file-watcher recent-decisions ring). Read path, no writes, nothing to
  // attribute — same posture as `handleMetricsAgentEffects`.
  'handleMetricsWatcherRecent',
  // `/api/client-logs` — web/browser renderer console-log ingest. Writes only
  // to the `renderer` pino log (diagnostics), no Y.Docs / agent content; gated
  // by `checkLocalOpSecurity` like the local-op handlers. No identity needed.
  'handleClientLogs',
  // `/api/comments` + `/api/comment` — comment-thread dispatchers (methodRouter
  // GET list/read + POST create/mutate). Same posture as the `handleSkill` /
  // `handleTemplate` dispatchers: the route-registry entry is the dispatcher,
  // and the mutating sub-handlers thread `extractActorIdentity` themselves in
  // `packages/server/src/comments/comment-api.ts`. Thread text is machine-local
  // (`.ok/local/comments/`), never committed, and the app is the only client
  // (agents reach comments via dispatch, not MCP).
  'handleCommentsRoute',
  'handleCommentRoute',
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
  // POST /api/local-op/auth/pat + /api/local-op/auth/gh-login — GHES sign-in
  // surfaces (validate + store a PAT; run `gh auth login --web` and stream its
  // progress). Machine-local credential operations, not agent-authored content —
  // same rationale as the sibling local-op auth handlers. No agent identity to
  // thread.
  'handleLocalOpAuthPat',
  'handleLocalOpAuthGhLogin',
  // POST /api/local-op/auth/cancel — user-initiated stop for an in-flight
  // device flow. Terminates a subprocess on the local machine; writes nothing.
  'handleLocalOpAuthCancel',
  // POST /api/local-op/embeddings/{set-key,clear-key} — loopback-gated writes of
  // the machine-global embeddings key to ~/.ok/secrets.yml. Operate on the local
  // user's credential file, not agent-authored content — same rationale as the
  // sibling local-op auth handlers. No agent identity to thread.
  'handleLocalOpEmbeddingsSetKey',
  'handleLocalOpEmbeddingsClearKey',
  // POST /api/local-op/embeddings/test — one probe embed of a fixed string
  // against the configured endpoint. Reads config + the credential file and
  // writes nothing; no document content, so no identity to thread.
  'handleLocalOpEmbeddingsTest',
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
  // `/api/config` — collab-bootstrap payload. GET reads server-lock. No Y.Doc
  // mutation and no agent content, so identity threading is exempt — same
  // rationale as `handleServerInfo`.
  'handleApiConfig',
  // `/api/config/diagnostics` — read-only GET reporting active config
  // diagnostics across the three layers. Reads config files, performs no
  // writes and no agent content, so there is nothing to attribute.
  'handleConfigDiagnostics',
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
  // cluster migrations land. Pick whichever source declares it (a lifted
  // handler is not in `api-extension.ts`), then whichever shape appears
  // first in that source.
  const fnDecl = `async function ${handlerName}(`;
  const constDecl = `const ${handlerName} = withValidation(`;
  const owner =
    HANDLER_SOURCES.find((text) => text.includes(fnDecl) || text.includes(constDecl)) ?? source;
  const fnIdx = owner.indexOf(fnDecl);
  const constIdx = owner.indexOf(constDecl);
  let start = -1;
  if (fnIdx !== -1) start = fnIdx;
  else if (constIdx !== -1) start = constIdx;
  if (start === -1) return null;
  const nextFn = owner.indexOf('\n  async function handle', start + 1);
  const nextConst = owner.indexOf('\n  const handle', start + 1);
  // Bound the last handler at the route table so the onRequest extension
  // body (which uses `errorResponse(...)` for the /api/* Origin gate) is
  // never folded into the handler slice. Factory modules end their handler
  // run at the returned record instead, so bound on that too.
  const nextRoutes = owner.indexOf('\n  const routes:', start + 1);
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
