import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type ContentFilter, createContentFilter } from '../content-filter.ts';
import { loggerFactory } from '../logger.ts';
import { BUNDLE_SKILL_NAME } from '../skill-bundles.ts';
import { createSkillsCatalogCache } from '../skills-catalog-cache.ts';
import { createSkillsListRoutes, type SkillsListRouteDeps } from './skills-list-routes.ts';

function buildGroup(overrides: Partial<SkillsListRouteDeps> = {}) {
  return createSkillsListRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    skillsHome: '/nonexistent-skills-home',
    contentFilter: undefined,
    catalogCache: createSkillsCatalogCache({
      homeDirOverride: '/nonexistent-skills-home',
      log: loggerFactory.getLogger('test'),
    }),
    resolveSkillsRoot: () => '/nonexistent-skills',
    resolveSkillsList: () => ({ skills: [], truncated: false }),
    skillOriginFor: () => ({ source: 'test', importedAt: '' }),
    localSkillHash: () => undefined,
    effectiveInstallMode: () => 'copy',
    pluginSelfIdentity: () => null,
    synthBuiltinLockEntry: () => null,
    synthPluginLockEntry: () => null,
    pluginUpstreamHash: () => null,
    builtinSkillListEntry: () => null,
    indexedSkillContentPath: () => null,
    healUnservableSkillAdmission: () => Promise.resolve(false),
    ...overrides,
  });
}

describe('createSkillsListRoutes table', () => {
  test('registers exactly the one skills-list path', () => {
    expect([...buildGroup().paths].sort()).toEqual(['/api/skills'].sort());
  });

  test('the skills-list read is not mutating', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skills']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

type BuiltinAssetCandidate = 'dist bundle asset' | 'committed source asset';

describe('createSkillsListRoutes builtin-row ignore-rule contract', () => {
  const BUNDLED_ASSET_SEGMENTS: Record<BuiltinAssetCandidate, string[]> = {
    'dist bundle asset': ['dist', 'assets', 'skills', 'project', 'SKILL.md'],
    'committed source asset': ['assets', 'skills', 'project', 'SKILL.md'],
  };

  const probeCases: Array<{ assetCandidate: BuiltinAssetCandidate; heals: boolean }> = [
    { assetCandidate: 'dist bundle asset', heals: false },
    { assetCandidate: 'dist bundle asset', heals: true },
  ];

  let tmpDir: string;
  let skillsHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-skills-list-routes-'));
    skillsHome = join(tmpDir, 'skills-home');
    mkdirSync(skillsHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function recordingContentFilter(): { contentFilter: ContentFilter; consultedPaths: string[] } {
    const consultedPaths: string[] = [];
    const contentFilter = {
      isPathIgnored: (relativePath: string) => {
        consultedPaths.push(relativePath);
        return true;
      },
      peekFreshInPlaceSkillDirsFingerprint: () => '',
    } as ContentFilter;
    return { contentFilter, consultedPaths };
  }

  function builtinRowEmitter(bundledSkillMd: string): SkillsListRouteDeps['builtinSkillListEntry'] {
    return (_base, name, scope) => {
      if (scope !== 'project') return null;
      return {
        name,
        scope,
        path: bundledSkillMd,
        absolutePath: bundledSkillMd,
        installed: false,
        hosts: [],
        managed: true,
      };
    };
  }

  async function readSkillsListResponse(group: ReturnType<typeof createSkillsListRoutes>): Promise<{
    status: number;
    body: string;
  }> {
    const dispatch = group.table.resolve('/api/skills')?.dispatch;
    const captured = { status: 0, body: '' };
    const res = {
      writeHead(status: number) {
        captured.status = status;
      },
      end(body?: string) {
        captured.body = body ?? '';
      },
    } as unknown as ServerResponse;
    const req = { method: 'GET', url: '/api/skills', headers: {} } as unknown as IncomingMessage;
    await dispatch?.(req, res);
    return captured;
  }

  test.each(probeCases)(
    'builtin bundle row ($assetCandidate, healing pass: $heals): ignore rules never see its absolute path and it lists unflagged',
    async ({ assetCandidate, heals }) => {
      const bundledSkillMd = join(
        tmpDir,
        'packages',
        'server',
        ...BUNDLED_ASSET_SEGMENTS[assetCandidate],
      );
      const { contentFilter, consultedPaths } = recordingContentFilter();
      const group = buildGroup({
        contentDir: tmpDir,
        projectDir: tmpDir,
        skillsHome,
        contentFilter,
        builtinSkillListEntry: builtinRowEmitter(bundledSkillMd),
        healUnservableSkillAdmission: () => Promise.resolve(heals),
      });

      const captured = await readSkillsListResponse(group);

      expect(
        captured.status,
        `expected 200 from the skills list handler, got HTTP ${captured.status} with body ${captured.body}`,
      ).toBe(200);
      const parsed = JSON.parse(captured.body) as {
        skills?: Array<{ name: string; ignored?: boolean }>;
      };
      expect(
        Array.isArray(parsed.skills),
        `expected a skills array in the list response, got body keys [${Object.keys(parsed).join(', ')}]`,
      ).toBe(true);
      const skills = parsed.skills ?? [];
      const rowNames = skills.map((s) => s.name);
      const builtinRow = skills.find((s) => s.name === BUNDLE_SKILL_NAME.project);
      expect(
        builtinRow,
        `expected the builtin bundle row ${BUNDLE_SKILL_NAME.project} in the list response, got rows [${rowNames.join(', ')}]`,
      ).toBeDefined();
      const absoluteConsultations = consultedPaths.filter((p) => isAbsolute(p));
      expect(
        absoluteConsultations,
        `isPathIgnored was consulted with absolute path(s) [${absoluteConsultations.join(', ')}]; the skills-list enrichment and its post-heal re-map must not feed absolute paths to ignore rules`,
      ).toEqual([]);
      expect(
        builtinRow?.ignored,
        `expected the builtin bundle row ${BUNDLE_SKILL_NAME.project} to be listed without ignored: true, got ignored=${builtinRow?.ignored}`,
      ).not.toBe(true);
    },
  );

  test.each([{ heals: false }, { heals: true }])(
    'builtin bundle row with the real filter, committed source asset (healing pass: $heals): both route guards keep the matcher from seeing the absolute path',
    async ({ heals }) => {
      const bundledSkillMd = join(
        tmpDir,
        'packages',
        'server',
        ...BUNDLED_ASSET_SEGMENTS['committed source asset'],
      );
      const contentFilter = createContentFilter({ projectDir: tmpDir, contentDir: tmpDir });
      const group = buildGroup({
        contentDir: tmpDir,
        projectDir: tmpDir,
        skillsHome,
        contentFilter,
        builtinSkillListEntry: builtinRowEmitter(bundledSkillMd),
        healUnservableSkillAdmission: () => Promise.resolve(heals),
      });

      const captured = await readSkillsListResponse(group);

      expect(
        captured.status,
        `expected 200: the route declines to consult the filter with the row's absolute path, so the matcher is never asked to classify input it cannot, got HTTP ${captured.status} with body ${captured.body}`,
      ).toBe(200);
      const parsed = JSON.parse(captured.body) as {
        skills?: Array<{ name: string; ignored?: boolean }>;
      };
      const builtinRow = parsed.skills?.find((s) => s.name === BUNDLE_SKILL_NAME.project);
      expect(
        builtinRow,
        `expected the builtin bundle row ${BUNDLE_SKILL_NAME.project} in the list response, got rows [${(parsed.skills ?? []).map((s) => s.name).join(', ')}]`,
      ).toBeDefined();
      expect(
        builtinRow?.ignored,
        `expected the builtin bundle row ${BUNDLE_SKILL_NAME.project} to list without ignored: true when the route declines to consult the filter with its absolute path, got ignored=${builtinRow?.ignored}`,
      ).not.toBe(true);
    },
  );

  test('builtin bundle row with the real filter, dist-segment shape: the filter would answer ignored via its segment scan, the route deliberately lists it unflagged', async () => {
    const bundledSkillMd = join(
      tmpDir,
      'packages',
      'server',
      ...BUNDLED_ASSET_SEGMENTS['dist bundle asset'],
    );
    const contentFilter = createContentFilter({ projectDir: tmpDir, contentDir: tmpDir });
    expect(
      contentFilter.isPathIgnored(bundledSkillMd),
      'contrast: consulted directly, the filter answers true for this shape via its BUILTIN_SKIP_DIRS segment scan',
    ).toBe(true);

    const group = buildGroup({
      contentDir: tmpDir,
      projectDir: tmpDir,
      skillsHome,
      contentFilter,
      builtinSkillListEntry: builtinRowEmitter(bundledSkillMd),
      healUnservableSkillAdmission: () => Promise.resolve(false),
    });

    const captured = await readSkillsListResponse(group);

    expect(
      captured.status,
      `expected 200, got HTTP ${captured.status} with body ${captured.body}`,
    ).toBe(200);
    const parsed = JSON.parse(captured.body) as {
      skills?: Array<{ name: string; ignored?: boolean }>;
    };
    const builtinRow = parsed.skills?.find((s) => s.name === BUNDLE_SKILL_NAME.project);
    expect(
      builtinRow?.ignored,
      `the route declines to consult the filter for paths outside its classification domain and answers unflagged at the API, got ignored=${builtinRow?.ignored}`,
    ).not.toBe(true);
  });
});
