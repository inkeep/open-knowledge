import { readFileSync } from 'node:fs';
import * as root from '@inkeep/open-knowledge-core';
import * as agentRegistrySubpath from '@inkeep/open-knowledge-core/agent-registry';
import * as bridgeSubpath from '@inkeep/open-knowledge-core/bridge';
import * as bugReportSidecarNoteContentSubpath from '@inkeep/open-knowledge-core/bug-report-sidecar/note-content';
import * as checkpointKindsSubpath from '@inkeep/open-knowledge-core/checkpoint-kinds';
import * as clientVersionSubpath from '@inkeep/open-knowledge-core/client-version';
import * as commandsCommandIdentitySubpath from '@inkeep/open-knowledge-core/commands/command-identity';
import * as commentsLeafTextSubpath from '@inkeep/open-knowledge-core/comments/leaf-text';
import * as commentsPassageMatchSubpath from '@inkeep/open-knowledge-core/comments/passage-match';
import * as configAutoSyncModeSubpath from '@inkeep/open-knowledge-core/config/auto-sync-mode';
import * as configBindConfigDocSubpath from '@inkeep/open-knowledge-core/config/bind-config-doc';
import * as configBindOkignoreDocSubpath from '@inkeep/open-knowledge-core/config/bind-okignore-doc';
import * as configErrorsSubpath from '@inkeep/open-knowledge-core/config/errors';
import * as configFieldRegistrySubpath from '@inkeep/open-knowledge-core/config/field-registry';
import * as configMergeLayeredSubpath from '@inkeep/open-knowledge-core/config/merge-layered';
import * as configSchemaSubpath from '@inkeep/open-knowledge-core/config/schema';
import * as configSchemaLeafSubpath from '@inkeep/open-knowledge-core/config/schema-leaf';
import * as constantsActivitySubpath from '@inkeep/open-knowledge-core/constants/activity';
import * as constantsCc1Subpath from '@inkeep/open-knowledge-core/constants/cc1';
import * as constantsChromeSubpath from '@inkeep/open-knowledge-core/constants/chrome';
import * as constantsCodeLanguagesSubpath from '@inkeep/open-knowledge-core/constants/code-languages';
import * as constantsCreateNewBannerSubpath from '@inkeep/open-knowledge-core/constants/create-new-banner';
import * as constantsCreateNewProjectReasonSubpath from '@inkeep/open-knowledge-core/constants/create-new-project-reason';
import * as constantsDocLifecycleSubpath from '@inkeep/open-knowledge-core/constants/doc-lifecycle';
import * as constantsDocumentOpenSubpath from '@inkeep/open-knowledge-core/constants/document-open';
import * as constantsEditorsSubpath from '@inkeep/open-knowledge-core/constants/editors';
import * as constantsEmbeddedHostSubpath from '@inkeep/open-knowledge-core/constants/embedded-host';
import * as constantsFeatureFlagsSubpath from '@inkeep/open-knowledge-core/constants/feature-flags';
import * as constantsGithubSubpath from '@inkeep/open-knowledge-core/constants/github';
import * as constantsGraphSubpath from '@inkeep/open-knowledge-core/constants/graph';
import * as constantsManualUpdateCheckSubpath from '@inkeep/open-knowledge-core/constants/manual-update-check';
import * as constantsMcpSubpath from '@inkeep/open-knowledge-core/constants/mcp';
import * as constantsMenuLabelsSubpath from '@inkeep/open-knowledge-core/constants/menu-labels';
import * as constantsNativeMenuLabelsSubpath from '@inkeep/open-knowledge-core/constants/native-menu-labels';
import * as constantsPreviewEmbedStartersSubpath from '@inkeep/open-knowledge-core/constants/preview-embed-starters';
import * as constantsPreviewThemeTokensSubpath from '@inkeep/open-knowledge-core/constants/preview-theme-tokens';
import * as constantsProductSubpath from '@inkeep/open-knowledge-core/constants/product';
import * as constantsSkillsSubpath from '@inkeep/open-knowledge-core/constants/skills';
import * as constantsUninstallFeedbackSubpath from '@inkeep/open-knowledge-core/constants/uninstall-feedback';
import * as constantsUploadSubpath from '@inkeep/open-knowledge-core/constants/upload';
import * as extensionsCodeBlockFidelitySubpath from '@inkeep/open-knowledge-core/extensions/code-block-fidelity';
import * as extensionsFootnoteReferenceSubpath from '@inkeep/open-knowledge-core/extensions/footnote-reference';
import * as extensionsFrontmatterSubpath from '@inkeep/open-knowledge-core/extensions/frontmatter';
import * as extensionsImageReferenceFidelitySubpath from '@inkeep/open-knowledge-core/extensions/image-reference-fidelity';
import * as extensionsImageSrcFidelitySubpath from '@inkeep/open-knowledge-core/extensions/image-src-fidelity';
import * as extensionsJsxComponentSubpath from '@inkeep/open-knowledge-core/extensions/jsx-component';
import * as extensionsJsxInlineSubpath from '@inkeep/open-knowledge-core/extensions/jsx-inline';
import * as extensionsLinkFidelitySubpath from '@inkeep/open-knowledge-core/extensions/link-fidelity';
import * as extensionsMathInlineSubpath from '@inkeep/open-knowledge-core/extensions/math-inline';
import * as extensionsRawMdxFallbackSubpath from '@inkeep/open-knowledge-core/extensions/raw-mdx-fallback';
import * as extensionsSharedSubpath from '@inkeep/open-knowledge-core/extensions/shared';
import * as extensionsTagSubpath from '@inkeep/open-knowledge-core/extensions/tag';
import * as extensionsWikiLinkSubpath from '@inkeep/open-knowledge-core/extensions/wiki-link';
import * as extensionsWikiLinkEmbedSubpath from '@inkeep/open-knowledge-core/extensions/wiki-link-embed';
import * as frontmatterErrorsSubpath from '@inkeep/open-knowledge-core/frontmatter/errors';
import * as frontmatterSchemaSubpath from '@inkeep/open-knowledge-core/frontmatter/schema';
import * as frontmatterTagsSubpath from '@inkeep/open-knowledge-core/frontmatter/tags';
import * as frontmatterDiffSubpath from '@inkeep/open-knowledge-core/frontmatter-diff';
import * as gitWorktreeInventoryModelSubpath from '@inkeep/open-knowledge-core/git/worktree-inventory-model';
import * as gitWorktreeSelectorModelSubpath from '@inkeep/open-knowledge-core/git/worktree-selector-model';
import * as handoffSubpath from '@inkeep/open-knowledge-core/handoff';
import * as i18nBrowserLocaleProviderSubpath from '@inkeep/open-knowledge-core/i18n/browser-locale-provider';
import * as i18nDirectionSubpath from '@inkeep/open-knowledge-core/i18n/direction';
import * as i18nLocalesSubpath from '@inkeep/open-knowledge-core/i18n/locales';
import * as i18nResolveLocaleSubpath from '@inkeep/open-knowledge-core/i18n/resolve-locale';
import * as loggerTypesSubpath from '@inkeep/open-knowledge-core/logger-types';
import * as loggingRendererLogSubpath from '@inkeep/open-knowledge-core/logging/renderer-log';
import * as loggingSecretScrubSubpath from '@inkeep/open-knowledge-core/logging/secret-scrub';
import * as markdownSubpath from '@inkeep/open-knowledge-core/markdown';
import * as markdownCodeFenceSubpath from '@inkeep/open-knowledge-core/markdown/code-fence';
import * as markdownHtmlToMdastSubpath from '@inkeep/open-knowledge-core/markdown/html-to-mdast';
import * as markdownLintSubpath from '@inkeep/open-knowledge-core/markdown/lint';
import * as markdownMdastToHtmlSubpath from '@inkeep/open-knowledge-core/markdown/mdast-to-html';
import * as markdownPlainTextSubpath from '@inkeep/open-knowledge-core/markdown/plain-text';
import * as markdownReferenceLabelSubpath from '@inkeep/open-knowledge-core/markdown/reference-label';
import * as markdownResolveImageUrlSubpath from '@inkeep/open-knowledge-core/markdown/resolve-image-url';
import * as markdownSafeUrlSubpath from '@inkeep/open-knowledge-core/markdown/safe-url';
import * as markdownTagPromotionSubpath from '@inkeep/open-knowledge-core/markdown/tag-promotion';
import * as metricsParseHealthSubpath from '@inkeep/open-knowledge-core/metrics/parse-health';
import * as registrySubpath from '@inkeep/open-knowledge-core/registry';
import * as registryTypesSubpath from '@inkeep/open-knowledge-core/registry/types';
import * as schemasApiSubpath from '@inkeep/open-knowledge-core/schemas/api';
import * as schemasCc1Subpath from '@inkeep/open-knowledge-core/schemas/cc1';
import * as searchWorkspaceSearchSubpath from '@inkeep/open-knowledge-core/search/workspace-search';
import * as seedPlanWorkSubpath from '@inkeep/open-knowledge-core/seed-plan-work';
import * as sharingSubpath from '@inkeep/open-knowledge-core/sharing';
import * as skillTargetsSchemaSubpath from '@inkeep/open-knowledge-core/skill-targets/schema';
import * as skillsCatalogSchemaSubpath from '@inkeep/open-knowledge-core/skills-catalog/schema';
import * as skillsCatalogScopeSubpath from '@inkeep/open-knowledge-core/skills-catalog/scope';
import * as skillsCatalogSkillCostSubpath from '@inkeep/open-knowledge-core/skills-catalog/skill-cost';
import * as skillsCatalogSourceFieldsSubpath from '@inkeep/open-knowledge-core/skills-catalog/source-fields';
import * as syncPausedReasonSubpath from '@inkeep/open-knowledge-core/sync-paused-reason';
import * as terminalLayoutSubpath from '@inkeep/open-knowledge-core/terminal-layout';
import * as themeBase16Subpath from '@inkeep/open-knowledge-core/theme/base16';
import * as themeThemePluginsSubpath from '@inkeep/open-knowledge-core/theme/theme-plugins';
import * as typesAwarenessSubpath from '@inkeep/open-knowledge-core/types/awareness';
import * as typesIdentitySubpath from '@inkeep/open-knowledge-core/types/identity';
import * as typesPrincipalSubpath from '@inkeep/open-knowledge-core/types/principal';
import * as typesTimelineSubpath from '@inkeep/open-knowledge-core/types/timeline';
import * as uninstallBridgeSubpath from '@inkeep/open-knowledge-core/uninstall-bridge';
import * as utilDocNameSubpath from '@inkeep/open-knowledge-core/util/doc-name';
import * as utilsAssetHrefSubpath from '@inkeep/open-knowledge-core/utils/asset-href';
import * as utilsChunkedInsertSubpath from '@inkeep/open-knowledge-core/utils/chunked-insert';
import * as utilsCodeFenceTrackerSubpath from '@inkeep/open-knowledge-core/utils/code-fence-tracker';
import * as utilsEmbedUrlRewriteSubpath from '@inkeep/open-knowledge-core/utils/embed-url-rewrite';
import * as utilsExtensionSubpath from '@inkeep/open-knowledge-core/utils/extension';
import * as utilsFileSizeSubpath from '@inkeep/open-knowledge-core/utils/file-size';
import * as utilsGithubStarsSubpath from '@inkeep/open-knowledge-core/utils/github-stars';
import * as utilsHeadingScanSubpath from '@inkeep/open-knowledge-core/utils/heading-scan';
import * as utilsIdentitySubpath from '@inkeep/open-knowledge-core/utils/identity';
import * as utilsLinkTargetsSubpath from '@inkeep/open-knowledge-core/utils/link-targets';
import * as utilsLoomEmbedSubpath from '@inkeep/open-knowledge-core/utils/loom-embed';
import * as utilsPdfAnchorSubpath from '@inkeep/open-knowledge-core/utils/pdf-anchor';
import * as utilsRandomUuidSubpath from '@inkeep/open-knowledge-core/utils/random-uuid';
import * as utilsRelativeTimeSubpath from '@inkeep/open-knowledge-core/utils/relative-time';
import * as utilsResolveInternalHrefSubpath from '@inkeep/open-knowledge-core/utils/resolve-internal-href';
import * as utilsSanitizeFolderNameSubpath from '@inkeep/open-knowledge-core/utils/sanitize-folder-name';
import * as utilsSlugSubpath from '@inkeep/open-knowledge-core/utils/slug';
import * as utilsTargetIdentitySubpath from '@inkeep/open-knowledge-core/utils/target-identity';
import * as utilsTargetNamespaceSubpath from '@inkeep/open-knowledge-core/utils/target-namespace';
import * as utilsVimeoEmbedSubpath from '@inkeep/open-knowledge-core/utils/vimeo-embed';
import * as utilsWikiLinkResolveSubpath from '@inkeep/open-knowledge-core/utils/wiki-link-resolve';
import * as utilsYoutubeEmbedSubpath from '@inkeep/open-knowledge-core/utils/youtube-embed';
import { describe, expect, test } from 'vitest';

const PRE_EXISTING_KEYS = [
  '.',
  './shadow-repo-layout',
  './skill-folder-state',
  './git-repository',
  './server',
  './keepalive',
  './helper-bundle',
  './skills-catalog',
  './acp/thread-protocol',
  './acp/agent-posture',
  './acp/permissive-mode',
  './acp/codex-legacy-notice',
  './acp/tool-call-input',
  './desktop-bridge',
];

const MODULE_SUBPATHS: Record<string, object> = {
  './agent-registry': agentRegistrySubpath,
  './bridge': bridgeSubpath,
  './bug-report-sidecar/note-content': bugReportSidecarNoteContentSubpath,
  './checkpoint-kinds': checkpointKindsSubpath,
  './client-version': clientVersionSubpath,
  './commands/command-identity': commandsCommandIdentitySubpath,
  './comments/leaf-text': commentsLeafTextSubpath,
  './comments/passage-match': commentsPassageMatchSubpath,
  './config/auto-sync-mode': configAutoSyncModeSubpath,
  './config/bind-config-doc': configBindConfigDocSubpath,
  './config/bind-okignore-doc': configBindOkignoreDocSubpath,
  './config/errors': configErrorsSubpath,
  './config/field-registry': configFieldRegistrySubpath,
  './config/merge-layered': configMergeLayeredSubpath,
  './config/schema': configSchemaSubpath,
  './config/schema-leaf': configSchemaLeafSubpath,
  './constants/activity': constantsActivitySubpath,
  './constants/cc1': constantsCc1Subpath,
  './constants/chrome': constantsChromeSubpath,
  './constants/code-languages': constantsCodeLanguagesSubpath,
  './constants/create-new-banner': constantsCreateNewBannerSubpath,
  './constants/create-new-project-reason': constantsCreateNewProjectReasonSubpath,
  './constants/doc-lifecycle': constantsDocLifecycleSubpath,
  './constants/document-open': constantsDocumentOpenSubpath,
  './constants/editors': constantsEditorsSubpath,
  './constants/embedded-host': constantsEmbeddedHostSubpath,
  './constants/feature-flags': constantsFeatureFlagsSubpath,
  './constants/github': constantsGithubSubpath,
  './constants/graph': constantsGraphSubpath,
  './constants/manual-update-check': constantsManualUpdateCheckSubpath,
  './constants/mcp': constantsMcpSubpath,
  './constants/menu-labels': constantsMenuLabelsSubpath,
  './constants/native-menu-labels': constantsNativeMenuLabelsSubpath,
  './constants/preview-embed-starters': constantsPreviewEmbedStartersSubpath,
  './constants/preview-theme-tokens': constantsPreviewThemeTokensSubpath,
  './constants/product': constantsProductSubpath,
  './constants/skills': constantsSkillsSubpath,
  './constants/uninstall-feedback': constantsUninstallFeedbackSubpath,
  './constants/upload': constantsUploadSubpath,
  './extensions/code-block-fidelity': extensionsCodeBlockFidelitySubpath,
  './extensions/footnote-reference': extensionsFootnoteReferenceSubpath,
  './extensions/frontmatter': extensionsFrontmatterSubpath,
  './extensions/image-reference-fidelity': extensionsImageReferenceFidelitySubpath,
  './extensions/image-src-fidelity': extensionsImageSrcFidelitySubpath,
  './extensions/jsx-component': extensionsJsxComponentSubpath,
  './extensions/jsx-inline': extensionsJsxInlineSubpath,
  './extensions/link-fidelity': extensionsLinkFidelitySubpath,
  './extensions/math-inline': extensionsMathInlineSubpath,
  './extensions/raw-mdx-fallback': extensionsRawMdxFallbackSubpath,
  './extensions/shared': extensionsSharedSubpath,
  './extensions/tag': extensionsTagSubpath,
  './extensions/wiki-link': extensionsWikiLinkSubpath,
  './extensions/wiki-link-embed': extensionsWikiLinkEmbedSubpath,
  './frontmatter-diff': frontmatterDiffSubpath,
  './frontmatter/errors': frontmatterErrorsSubpath,
  './frontmatter/schema': frontmatterSchemaSubpath,
  './frontmatter/tags': frontmatterTagsSubpath,
  './git/worktree-inventory-model': gitWorktreeInventoryModelSubpath,
  './git/worktree-selector-model': gitWorktreeSelectorModelSubpath,
  './handoff': handoffSubpath,
  './i18n/browser-locale-provider': i18nBrowserLocaleProviderSubpath,
  './i18n/direction': i18nDirectionSubpath,
  './i18n/locales': i18nLocalesSubpath,
  './i18n/resolve-locale': i18nResolveLocaleSubpath,
  './logger-types': loggerTypesSubpath,
  './logging/renderer-log': loggingRendererLogSubpath,
  './logging/secret-scrub': loggingSecretScrubSubpath,
  './markdown': markdownSubpath,
  './markdown/code-fence': markdownCodeFenceSubpath,
  './markdown/html-to-mdast': markdownHtmlToMdastSubpath,
  './markdown/lint': markdownLintSubpath,
  './markdown/mdast-to-html': markdownMdastToHtmlSubpath,
  './markdown/plain-text': markdownPlainTextSubpath,
  './markdown/reference-label': markdownReferenceLabelSubpath,
  './markdown/resolve-image-url': markdownResolveImageUrlSubpath,
  './markdown/safe-url': markdownSafeUrlSubpath,
  './markdown/tag-promotion': markdownTagPromotionSubpath,
  './metrics/parse-health': metricsParseHealthSubpath,
  './registry': registrySubpath,
  './registry/types': registryTypesSubpath,
  './schemas/api': schemasApiSubpath,
  './schemas/cc1': schemasCc1Subpath,
  './search/workspace-search': searchWorkspaceSearchSubpath,
  './seed-plan-work': seedPlanWorkSubpath,
  './sharing': sharingSubpath,
  './skill-targets/schema': skillTargetsSchemaSubpath,
  './skills-catalog/schema': skillsCatalogSchemaSubpath,
  './skills-catalog/scope': skillsCatalogScopeSubpath,
  './skills-catalog/skill-cost': skillsCatalogSkillCostSubpath,
  './skills-catalog/source-fields': skillsCatalogSourceFieldsSubpath,
  './sync-paused-reason': syncPausedReasonSubpath,
  './terminal-layout': terminalLayoutSubpath,
  './theme/base16': themeBase16Subpath,
  './theme/theme-plugins': themeThemePluginsSubpath,
  './types/awareness': typesAwarenessSubpath,
  './types/identity': typesIdentitySubpath,
  './types/principal': typesPrincipalSubpath,
  './types/timeline': typesTimelineSubpath,
  './uninstall-bridge': uninstallBridgeSubpath,
  './util/doc-name': utilDocNameSubpath,
  './utils/asset-href': utilsAssetHrefSubpath,
  './utils/chunked-insert': utilsChunkedInsertSubpath,
  './utils/code-fence-tracker': utilsCodeFenceTrackerSubpath,
  './utils/embed-url-rewrite': utilsEmbedUrlRewriteSubpath,
  './utils/extension': utilsExtensionSubpath,
  './utils/file-size': utilsFileSizeSubpath,
  './utils/github-stars': utilsGithubStarsSubpath,
  './utils/heading-scan': utilsHeadingScanSubpath,
  './utils/identity': utilsIdentitySubpath,
  './utils/link-targets': utilsLinkTargetsSubpath,
  './utils/loom-embed': utilsLoomEmbedSubpath,
  './utils/pdf-anchor': utilsPdfAnchorSubpath,
  './utils/random-uuid': utilsRandomUuidSubpath,
  './utils/relative-time': utilsRelativeTimeSubpath,
  './utils/resolve-internal-href': utilsResolveInternalHrefSubpath,
  './utils/sanitize-folder-name': utilsSanitizeFolderNameSubpath,
  './utils/slug': utilsSlugSubpath,
  './utils/target-identity': utilsTargetIdentitySubpath,
  './utils/target-namespace': utilsTargetNamespaceSubpath,
  './utils/vimeo-embed': utilsVimeoEmbedSubpath,
  './utils/wiki-link-resolve': utilsWikiLinkResolveSubpath,
  './utils/youtube-embed': utilsYoutubeEmbedSubpath,
};

const CONDITION_ORDER = ['@inkeep/source', 'development', 'types', 'default'];

const packageJson: { exports: Record<string, Record<string, string>> } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

const rootBindings = new Map(Object.entries(root));

describe('per-module core subpaths', () => {
  test('every export key beside the pre-existing entries is imported by this contract', () => {
    const declared = Object.keys(packageJson.exports).filter(
      (key) => !PRE_EXISTING_KEYS.includes(key),
    );
    expect(Object.keys(MODULE_SUBPATHS).sort()).toEqual(declared.sort());
  });

  test.each(Object.keys(MODULE_SUBPATHS))(
    '%s points its conditions at the module its name implies',
    (key) => {
      const conditions = packageJson.exports[key];
      const modulePath = key.slice(2);
      const flatName = modulePath.replaceAll('/', '-');
      expect(Object.keys(conditions ?? {})).toEqual(CONDITION_ORDER);
      expect([`./src/${modulePath}.ts`, `./src/${modulePath}/index.ts`]).toContain(
        conditions?.['@inkeep/source'],
      );
      expect(conditions?.development).toBe(conditions?.['@inkeep/source']);
      expect(conditions?.types).toBe(`./dist/${flatName}.d.mts`);
      expect(conditions?.default).toBe(`./dist/${flatName}.mjs`);
    },
  );

  test.each(Object.entries(MODULE_SUBPATHS))(
    '%s serves the same runtime bindings as the root barrel',
    (_key, namespace) => {
      const bindings = Object.entries(namespace);
      const shared = bindings.filter(([name]) => rootBindings.has(name));
      const divergent = shared
        .filter(([name, value]) => value !== rootBindings.get(name))
        .map(([name]) => name);
      expect(divergent).toEqual([]);
      if (bindings.length > 0) expect(shared.length).toBeGreaterThan(0);
    },
  );
});
