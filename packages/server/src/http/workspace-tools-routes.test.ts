import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import type { SearchService } from '../services/search.ts';
import { createWorkspaceToolsRoutes } from './workspace-tools-routes.ts';

function buildGroup() {
  return createWorkspaceToolsRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    skillsHome: '/nonexistent-skills-home',
    homeDirOverride: '/nonexistent-home',
    savedThemeLockTimeoutMs: undefined,
    ephemeral: true,
    log: loggerFactory.getLogger('test'),
    signalChannel: undefined,
    searchService: {} as SearchService,
    linkPreviewFetch: undefined,
    getLinkPreviewsEnabled: undefined,
    declaredGitHubHosts: new Set<string>(),
    resolveGitHubToken: undefined,
    githubReferenceFetch: undefined,
    getGeneratedIndexSettingsStatus: undefined,
    setGeneratedIndexEnabled: undefined,
  });
}

describe('createWorkspaceToolsRoutes table', () => {
  test('registers exactly the seven workspace-tool paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/search',
        '/api/link-preview',
        '/api/github-reference',
        '/api/skill-targets',
        '/api/saved-themes',
        '/api/saved-theme',
        '/api/generated-index/settings',
      ].sort(),
    );
  });

  test('legacy MUTATING_ROUTES members are mutating on every verb; the reads are not', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/skill-targets',
      '/api/saved-theme',
      '/api/generated-index/settings',
    ]) {
      expect(table.isMutating(path), path).toBe(true);
    }
    for (const path of ['/api/search', '/api/link-preview', '/api/saved-themes']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
