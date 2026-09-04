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

const REQUIRED_HANDLERS = [
  'handleAgentWrite',
  'handleAgentWriteMd',
  'handleAgentWriteBatch',
  'handleAgentPatch',
  'handleAgentUndo',
  'handleRollback',
  'handleRenamePath',
  'handleDeletePath',
  'handleDuplicatePath',
  'handleTemplate',
  'handleTemplatePut',
  'handleTemplateDelete',
  'handleTemplateMove',
  'handleTemplateImport',
  'handleSkill',
  'handleSkillPut',
  'handleSkillFile',
  'handleSkillFilePut',
  'handleSkillFileRename',
  'handleLintFix',
];

const EXEMPT_HANDLERS = new Set([
  'handleDocumentRead',
  'handleDocumentList',
  'handleAcpCatalog',
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
  'handleGeneratedIndexSettings',
  'handleSavedThemesList',
  'handleSavedTheme',
  'handleGetLintConfig',
  'handleWriteMarkdownlintRule',
  'handleWriteFrontmatterSchema',
  'handleFrontmatterSchemasList',
  'handleLintDoc',
  'handleLintAudit',
  'handleAudit',
  'handleTemplatesList',
  'handleSuggestLinks',
  'handlePageHeadings',
  'handleHistory',
  'handleHistoryVersion',
  'handleMetricsReconciliation',
  'handleMetricsParseHealth',
  'handleMetricsAgentPresence',
  'handleMetricsAgentEffects',
  'handleMetricsWatcherRecent',
  'handleEmbedDetect',
  'handleClientLogs',
  'handleCommentsRoute',
  'handleCommentRoute',
  'handleWorkspace',
  'handleApiConfig',
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
  'handleSpawnCursorRoute',
  'handleHandoffDispatchRoute',
  'handleInstallSkill',
  'handleSkillInstallState',
  'handleSkillsList',
  'handleSkillInstall',
  'handleSkillUninstall',
  'handleSkillTargets',
  'handleSkillRestore',
  'handleSkillRevert',
  'handleSkillsManagement',
  'handleSkillTrackInGit',
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
  'handleSkillEditExternal',
  'handleSkillReimport',
  'handleSkillsReimportBulk',
  'handleSkillUpload',
  'handleSkillMoveScope',
  'handleSkillDuplicate',
  'handleSeedPlan',
  'handleSeedApply',
  'handleSeedInstallPackSkill',
  'handleSeedPacks',
  'handleShareConstructUrl',
  'handleSharePublishOwners',
  'handleSharePublishNameCheck',
  'handleSharePublish',
  'handleBranchInfo',
  'handleGitWorktreeStatus',
  'handleCheckout',
  'handleSyncResolveBlocking',
  'handleShareTargetStatus',
  'handleTestReset',
  'handleTestRescanBacklinks',
  'handleTestRescanFiles',
  'handleSaveVersion',
  'handleCreatePage',
  'handleCreateFolder',
  'handleTrashCleanup',
  'handleUploadAsset',
  'handleFrontmatterPatch',
]);

function extractHandlerBody(handlerName: string): string | null {
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
  const nextRoutes = HANDLER_RUN_END_NEEDLES.map((needle) => owner.indexOf(needle, start + 1));
  const nextReturn = owner.indexOf('\n  return {', start + 1);
  const candidates = [nextFn, nextConst, ...nextRoutes, nextReturn].filter((i) => i !== -1);
  const next = candidates.length === 0 ? -1 : Math.min(...candidates);
  return owner.slice(start, next === -1 ? owner.length : next);
}

function extractStaticRouteHandlerNames(): string[] {
  return HANDLER_SOURCES.flatMap((text) => extractRouteHandlerNames(text));
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
      const directGate =
        body.includes('respondDocInConflict(') ||
        body.includes('checkTemplateConflictGate(') ||
        body.includes('checkSkillDocConflictGate(');
      const spineRouting =
        body.includes('applyAgentMarkdownWrite(') || body.includes('applyAgentUndo(');
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

  test('spine-level gate fires before transact in agent-sessions.ts', () => {
    const sessionsSrc = readFileSync(
      join(import.meta.dirname, '../../../server/src/agent-sessions.ts'),
      'utf8',
    );
    expect(sessionsSrc).toContain('throw new DocInConflictError');
    const throwMatches = sessionsSrc.match(/throw new DocInConflictError/g) ?? [];
    expect(throwMatches.length).toBeGreaterThanOrEqual(2);
  });
});
