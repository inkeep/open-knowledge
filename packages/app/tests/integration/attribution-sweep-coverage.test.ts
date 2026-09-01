import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractRouteHandlerNames,
  HANDLER_RUN_END_NEEDLES,
  listNativeRouteFiles,
} from '../native-route-files.test-helper.ts';

const API_EXT_PATH = join(import.meta.dirname, '../../../server/src/api-extension.ts');
const source = readFileSync(API_EXT_PATH, 'utf8');
const SERVER_SRC = join(import.meta.dirname, '../../../server/src');
const HANDLER_SOURCES = [
  source,
  ...['skills-sh-handlers.ts', ...listNativeRouteFiles(SERVER_SRC)].map((file) =>
    readFileSync(join(SERVER_SRC, file), 'utf8'),
  ),
];
const ACTOR_HELPER_PATH = join(
  import.meta.dirname,
  '../../../server/src/extract-actor-identity.ts',
);
const actorHelperSource = readFileSync(ACTOR_HELPER_PATH, 'utf8');

const REQUIRED_HANDLERS = [
  'handleAgentWrite',
  'handleAgentWriteMd',
  'handleAgentWriteBatch',
  'handleAgentPatch',
  'handleFrontmatterPatch',
  'handleAgentUndo',
  'handleSaveVersion',
  'handleRollback',
  'handleCreatePage',
  'handleCreateFolder',
  'handleRenamePath',
  'handleDeletePath',
  'handleDuplicatePath',
  'handleTrashCleanup',
  'handleUploadAsset',
  'handleSkillImport',
  'handleSkillsImportBulk',
  'handleSkillReimport',
  'handleSkillsReimportBulk',
  'handleSkillUpload',
  'handleSkillMoveScope',
  'handleSkillDuplicate',
  'handleLintFix',
];

const EXEMPT_HANDLERS = new Set([
  'handleDocumentRead',
  'handleDocumentList',
  'handleAcpCatalog',
  'handleEmbedDetect',
  'handleAsset',
  'handleAssetText',
  'handleBacklinks',
  'handleBacklinkCounts',
  'handleCommentCounts',
  'handleForwardLinks',
  'handleLinkPreview',
  'handleLinkGraph',
  'handleSearch',
  'handleSemanticStatus',
  'handleDeadLinks',
  'handleOrphans',
  'handleHubs',
  'handleTagsList',
  'handleTagsForName',
  'handlePages',
  'handleFolderConfig',
  'handleSavedThemesList',
  'handleSavedTheme',
  'handleTemplate',
  'handleGeneratedIndexSettings',
  'handleGetLintConfig',
  'handleWriteMarkdownlintRule',
  'handleWriteFrontmatterSchema',
  'handleFrontmatterSchemasList',
  'handleLintDoc',
  'handleLintAudit',
  'handleAudit',
  'handleTemplateImport',
  'handleTemplatesList',
  'handleSkill',
  'handleSkillFile',
  'handleSkillFileRename',
  'handleSkillsList',
  'handleSkillsSearch',
  'handleSkillsDetail',
  'handleSkillEditExternal',
  'handleSkillsDiscover',
  'handleSkillsPopular',
  'handleSkillsPublisher',
  'handleSkillsPreview',
  'handleSkillsResolveRef',
  'handleSkillsInstalled',
  'handleSkillInstall',
  'handleSkillUninstall',
  'handleSkillTargets',
  'handleSkillRestore',
  'handleSkillRevert',
  'handleSkillTrackInGit',
  'handleSuggestLinks',
  'handlePageHeadings',
  'handleHistory',
  'handleHistoryVersion',
  'handleMetricsReconciliation',
  'handleMetricsParseHealth',
  'handleMetricsAgentPresence',
  'handleMetricsAgentEffects',
  'handleMetricsWatcherRecent',
  'handleClientLogs',
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
  'handleLocalOpAuthPat',
  'handleLocalOpAuthGhLogin',
  'handleLocalOpAuthCancel',
  'handleLocalOpEmbeddingsSetKey',
  'handleLocalOpEmbeddingsClearKey',
  'handleLocalOpEmbeddingsTest',
  'handleTestReset',
  'handleTestFlushGit',
  'handlePrincipal',
  'handleInstalledAgentsRoute',
  'handleServerInfo',
  'handleApiConfig',
  'handleConfigDiagnostics',
  'handleSeedPlan',
  'handleSeedApply',
  'handleSeedInstallPackSkill',
  'handleSeedPacks',
  'handleAgentActivity',
  'handleAgentBurstDiff',
  'handleInstallSkill',
  'handleSkillInstallState',
  'handleSpawnCursorRoute',
  'handleHandoffDispatchRoute',
  'handleShareConstructUrl',
  'handleSharePublishOwners',
  'handleSharePublishNameCheck',
  'handleSharePublish',
  'handleBranchInfo',
  'handleGitWorktreeStatus',
  'handleCheckout',
  'handleSyncResolveBlocking',
  'handleShareTargetStatus',
]);

function extractHandlerBody(handlerName: string): string | null {
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
  const nextRoutes = HANDLER_RUN_END_NEEDLES.map((needle) => owner.indexOf(needle, start + 1));
  const nextReturn = owner.indexOf('\n  return {', start + 1);
  const candidates = [nextFn, nextConst, ...nextRoutes, nextReturn].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return owner.slice(start, next === -1 ? owner.length : next);
}

function extractStaticRouteHandlerNames(): string[] {
  return HANDLER_SOURCES.flatMap((text) => extractRouteHandlerNames(text));
}

describe('attribution sweep coverage (FR-5, D42)', () => {
  test('all required POST handlers call an identity-threading helper', () => {
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
    const code = actorHelperSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/body\s*[.[][^a-zA-Z0-9_]*['"]?principalId/.test(code)).toBe(false);
  });

  test('migrated mutating handlers extract identity before any semantic errorResponse', () => {
    const failures: string[] = [];
    for (const handler of REQUIRED_HANDLERS) {
      const body = extractHandlerBody(handler);
      if (body === null) continue;
      if (!body.includes('errorResponse(')) continue;
      const agentIdx = body.indexOf('extractAgentIdentity(');
      const actorIdx = body.indexOf('extractActorIdentity(');
      const presentIdxs = [agentIdx, actorIdx].filter((i) => i !== -1);
      const identityIdx = presentIdxs.length === 0 ? -1 : Math.min(...presentIdxs);
      if (identityIdx === -1) continue;

      const firstErrorIdx = body.indexOf('errorResponse(');
      if (firstErrorIdx > identityIdx) continue;
      const preIdentityRegion = body.slice(0, identityIdx);
      const allErrorEmitsPreIdentity = [...preIdentityRegion.matchAll(/errorResponse\(/g)].map(
        (m) => m.index ?? 0,
      );
      const bodyShapeContexts = [
        /method-not-allowed/,
        /malformed-upload/,
        /invalid-request/,
        /storage-/,
      ];
      const allBodyShape = allErrorEmitsPreIdentity.every((idx) => {
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
