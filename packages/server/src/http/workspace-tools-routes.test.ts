import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import type { SearchService } from '../services/search.ts';
import { createWorkspaceToolsRoutes } from './workspace-tools-routes.ts';

/**
 * Table-level pins for the workspace-tools group's mutating declaration.
 * The wire cannot pin this:
 * the read half of the DNS-rebinding defense applies the identical loopback +
 * workspace-Host checks to every `/api/*` request, so an emptied mutating set
 * changes no composition-suite response — only which gate (and telemetry tag)
 * fires first. The declared membership is pinned here directly against the
 * legacy `MUTATING_ROUTES` membership it reproduces, GET arms included.
 */

function buildGroup() {
  return createWorkspaceToolsRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    skillsHome: '/nonexistent-skills-home',
    homeDirOverride: '/nonexistent-home',
    savedThemeLockTimeoutMs: undefined,
    // Ephemeral keeps the link-preview cache memory-only — constructing the
    // group must not touch disk.
    ephemeral: true,
    log: loggerFactory.getLogger('test'),
    signalChannel: undefined,
    // Never dispatched by these pins; the table declaration is what's under test.
    searchService: {} as SearchService,
    linkPreviewFetch: undefined,
    getLinkPreviewsEnabled: undefined,
    getGeneratedIndexSettingsStatus: undefined,
    setGeneratedIndexEnabled: undefined,
  });
}

describe('createWorkspaceToolsRoutes table', () => {
  test('registers exactly the six workspace-tool paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/search',
        '/api/link-preview',
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
