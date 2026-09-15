import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { resolveProjectIdentity } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { createSkillsRecoveryRoutes } from './http/skills-recovery-routes.ts';

interface Observation {
  advancePerReadMs: number;
  advancePathPrefix?: string;
  hashes: number;
  reads: string[];
}

interface SkillsResponse {
  skills: Array<{
    name: string;
    provenance?: { projectPath?: string; scope?: string };
  }>;
}

interface LinkedFixture {
  bundleRoot: string;
  contentDir: string;
  home: string;
  mainDir: string;
  siblingDir: string;
}

const FOREIGN_PROJECT_COUNT = 20;
const MAIN_VERSION = '3.0.0';
const OWN_VERSION = '2.0.0';
const SIBLING_VERSION = '4.0.0';
const USER_VERSION = '9.0.0';
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalCreateHash = crypto.createHash.bind(crypto);
const readFileSyncDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFileSync');
const createHashDescriptor = Object.getOwnPropertyDescriptor(crypto, 'createHash');
let observation: Observation | null = null;
let fakeNow: number | null = null;
let root: string;
let server: BootedServer;
let createApiExtension: typeof import('./api-extension.test-helper.ts').createApiExtension;
let createSkillsCatalogCache: typeof import('./skills-catalog-cache.ts').createSkillsCatalogCache;
let getLogger: typeof import('./logger.ts').getLogger;
let makeCaptureRes: typeof import('./composition-rig.test-helper.ts').makeCaptureRes;
let makeSyntheticReq: typeof import('./composition-rig.test-helper.ts').makeSyntheticReq;

function installObservers(): void {
  if (readFileSyncDescriptor === undefined || createHashDescriptor === undefined) {
    throw new Error('Node builtin descriptors are unavailable');
  }
  Object.defineProperty(fs, 'readFileSync', {
    ...readFileSyncDescriptor,
    value: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = originalReadFileSync(...args);
      if (observation !== null) {
        const path = String(args[0]);
        observation.reads.push(path);
        if (
          fakeNow !== null &&
          (observation.advancePathPrefix === undefined ||
            path.startsWith(observation.advancePathPrefix))
        ) {
          fakeNow += observation.advancePerReadMs;
        }
      }
      return result;
    },
  });
  Object.defineProperty(crypto, 'createHash', {
    ...createHashDescriptor,
    value: (...args: Parameters<typeof crypto.createHash>) => {
      if (observation !== null) observation.hashes += 1;
      return originalCreateHash(...args);
    },
  });
  syncBuiltinESMExports();
}

function restoreObservers(): void {
  if (readFileSyncDescriptor !== undefined) {
    Object.defineProperty(fs, 'readFileSync', readFileSyncDescriptor);
  }
  if (createHashDescriptor !== undefined) {
    Object.defineProperty(crypto, 'createHash', createHashDescriptor);
  }
  syncBuiltinESMExports();
}

beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'ok-skills-plugin-scope-'));
  installObservers();
  ({ createApiExtension } = await import('./api-extension.test-helper.ts'));
  ({ createSkillsCatalogCache } = await import('./skills-catalog-cache.ts'));
  ({ getLogger } = await import('./logger.ts'));
  const composition = await import('./composition-rig.test-helper.ts');
  ({ makeCaptureRes, makeSyntheticReq } = composition);
  const runtime = fs.mkdtempSync(join(root, 'runtime-'));
  server = await composition.bootCompositionRig(runtime);
  await server.ready;
}, 60_000);

afterEach(() => {
  observation = null;
  fakeNow = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server?.destroy();
  restoreObservers();
  fs.rmSync(root, { recursive: true, force: true });
});

function startObservation(advancePerReadMs = 0, advancePathPrefix?: string): void {
  observation = {
    advancePerReadMs,
    ...(advancePathPrefix !== undefined ? { advancePathPrefix } : {}),
    hashes: 0,
    reads: [],
  };
}

function finishObservation(): Observation {
  if (observation === null) throw new Error('observation was not started');
  const completed = observation;
  observation = null;
  return completed;
}

function writeSkill(installPath: string, version: string): void {
  const skillDir = join(installPath, 'skills', 'fixture-skill');
  fs.mkdirSync(join(skillDir, 'references'), { recursive: true });
  fs.mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  fs.mkdirSync(join(skillDir, 'assets'), { recursive: true });
  fs.mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: fixture-skill\ndescription: Fixture ${version}\n---\n\nBody ${version}\n`,
  );
  fs.writeFileSync(join(skillDir, 'references', 'guide.md'), `guide ${version}\n`);
  fs.writeFileSync(join(skillDir, 'scripts', 'run.mjs'), `export const version = '${version}';\n`);
  fs.writeFileSync(join(skillDir, 'assets', 'payload.txt'), `payload ${version}\n`);
  fs.writeFileSync(
    join(installPath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'toolkit', version }),
  );
}

function createLinkedProject(): {
  contentDir: string;
  mainDir: string;
  siblingDir: string;
} {
  const mainDir = fs.mkdtempSync(join(root, 'linked-main-'));
  const contentDir = fs.mkdtempSync(join(root, 'linked-request-'));
  const siblingDir = fs.mkdtempSync(join(root, 'linked-sibling-'));
  for (const [name, worktreeDir] of [
    ['request', contentDir],
    ['sibling', siblingDir],
  ] as const) {
    const adminDir = join(mainDir, '.git', 'worktrees', name);
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(join(adminDir, 'commondir'), '../..\n');
    fs.writeFileSync(join(worktreeDir, '.git'), `gitdir: ${adminDir}\n`);
  }
  return { contentDir, mainDir, siblingDir };
}

function seedLinkedFixture(withInPlaceSkill: boolean, withForeignSites: boolean): LinkedFixture {
  const { contentDir, mainDir, siblingDir } = createLinkedProject();
  const home = fs.mkdtempSync(join(root, 'linked-home-'));
  const pluginsDir = join(home, '.claude', 'plugins');
  const bundleRoot = join(pluginsDir, 'cache', 'fixture', 'toolkit');
  const entries: Array<Record<string, string>> = [];
  const mainInstallPath = join(bundleRoot, MAIN_VERSION);
  writeSkill(mainInstallPath, MAIN_VERSION);
  entries.push({
    scope: 'project',
    projectPath: mainDir,
    installPath: mainInstallPath,
    version: MAIN_VERSION,
    lastUpdated: '2026-09-14T00:00:00Z',
  });
  if (withForeignSites) {
    for (const [projectPath, version, lastUpdated] of [
      [contentDir, OWN_VERSION, '2026-09-14T00:02:00Z'],
      [siblingDir, SIBLING_VERSION, '2026-09-14T00:01:00Z'],
    ] as const) {
      const installPath = join(bundleRoot, version);
      writeSkill(installPath, version);
      entries.push({ scope: 'project', projectPath, installPath, version, lastUpdated });
    }
  }
  const userInstallPath = join(bundleRoot, USER_VERSION);
  writeSkill(userInstallPath, USER_VERSION);
  entries.push({
    scope: 'user',
    installPath: userInstallPath,
    version: USER_VERSION,
    lastUpdated: '2026-09-14T00:03:00Z',
  });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'toolkit@fixture': entries } }),
  );
  fs.writeFileSync(
    join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({ fixture: { source: { source: 'github', repo: 'fixture/toolkit' } } }),
  );
  if (withInPlaceSkill) {
    const inPlace = join(contentDir, '.claude', 'skills', 'fixture-skill');
    fs.mkdirSync(inPlace, { recursive: true });
    fs.writeFileSync(
      join(inPlace, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: In place\n---\n\nBody.\n',
    );
  }
  return { bundleRoot, contentDir, home, mainDir, siblingDir };
}

function expectLinkedWorktreeParentIdentity(fixture: LinkedFixture): void {
  expect(resolveProjectIdentity(fixture.contentDir)).toBe(fixture.mainDir);
  expect(resolveProjectIdentity(fixture.contentDir)).not.toBe(fixture.contentDir);
}

function seedFixture(
  withInPlaceSkill: boolean,
  foreignProjectCount = FOREIGN_PROJECT_COUNT,
): {
  bundleRoot: string;
  contentDir: string;
  home: string;
} {
  const contentDir = fs.mkdtempSync(join(root, 'project-'));
  const home = fs.mkdtempSync(join(root, 'home-'));
  const pluginsDir = join(home, '.claude', 'plugins');
  const bundleRoot = join(pluginsDir, 'cache', 'fixture', 'toolkit');
  const entries: Array<Record<string, string>> = [];
  for (let index = 0; index < foreignProjectCount; index += 1) {
    const version = `1.0.${String(index).padStart(2, '0')}`;
    const installPath = join(bundleRoot, version);
    const projectPath = fs.mkdtempSync(join(root, 'foreign-project-'));
    writeSkill(installPath, version);
    entries.push({
      scope: 'project',
      projectPath,
      installPath,
      version,
      lastUpdated: `2026-09-14T00:00:${String(index).padStart(2, '0')}Z`,
    });
  }
  const ownInstallPath = join(bundleRoot, OWN_VERSION);
  writeSkill(ownInstallPath, OWN_VERSION);
  entries.push({
    scope: 'project',
    projectPath: contentDir,
    installPath: ownInstallPath,
    version: OWN_VERSION,
    lastUpdated: '2026-09-14T00:01:00Z',
  });
  const userInstallPath = join(bundleRoot, USER_VERSION);
  writeSkill(userInstallPath, USER_VERSION);
  entries.push({
    scope: 'user',
    installPath: userInstallPath,
    version: USER_VERSION,
    lastUpdated: '2026-09-14T00:02:00Z',
  });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'toolkit@fixture': entries } }),
  );
  fs.writeFileSync(
    join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({ fixture: { source: { source: 'github', repo: 'fixture/toolkit' } } }),
  );
  if (withInPlaceSkill) {
    const inPlace = join(contentDir, '.claude', 'skills', 'fixture-skill');
    fs.mkdirSync(inPlace, { recursive: true });
    fs.writeFileSync(
      join(inPlace, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: In place\n---\n\nBody.\n',
    );
  }
  return { bundleRoot, contentDir, home };
}

function addForeignDirectoryMarketplace(fixture: { contentDir: string; home: string }): string {
  const pluginsDir = join(fixture.home, '.claude', 'plugins');
  const marketplaceDir = fs.mkdtempSync(join(root, 'foreign-directory-marketplace-'));
  const marketplaceManifest = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  fs.mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    marketplaceManifest,
    JSON.stringify({
      name: 'foreign-directory',
      plugins: [{ name: 'foreign-toolkit', source: './plugins/foreign-toolkit' }],
    }),
  );
  const knownPath = join(pluginsDir, 'known_marketplaces.json');
  const known = JSON.parse(fs.readFileSync(knownPath, 'utf-8')) as Record<string, unknown>;
  known['foreign-directory'] = {
    source: { source: 'directory', path: marketplaceDir },
    installLocation: marketplaceDir,
  };
  fs.writeFileSync(knownPath, JSON.stringify(known));
  const installedPath = join(pluginsDir, 'installed_plugins.json');
  const installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8')) as {
    plugins: Record<string, Array<Record<string, string>>>;
  };
  installed.plugins['foreign-toolkit@foreign-directory'] = [
    {
      scope: 'project',
      projectPath: fs.mkdtempSync(join(root, 'foreign-directory-owner-')),
      installPath: join(root, 'missing-foreign-directory-cache'),
      version: '1.0.0',
      lastUpdated: '2026-09-14T00:00:00Z',
    },
  ];
  fs.writeFileSync(installedPath, JSON.stringify(installed));
  return marketplaceManifest;
}

function newCache(home: string) {
  return createSkillsCatalogCache({
    homeDirOverride: home,
    log: getLogger('skills-plugin-scope-test'),
  });
}

function versionsRead(result: Observation, bundleRoot: string): string[] {
  const prefix = `${bundleRoot}${sep}`;
  return [
    ...new Set(
      result.reads
        .filter((path) => path.startsWith(prefix))
        .map((path) => relative(bundleRoot, path).split(sep)[0])
        .filter((version): version is string => version !== undefined && version !== ''),
    ),
  ].sort();
}

async function request(
  extension: ReturnType<typeof createApiExtension>,
  path: string,
): Promise<SkillsResponse> {
  const req = makeSyntheticReq({ method: 'GET', url: path });
  const { res, captured } = makeCaptureRes();
  await extension.onRequest({ request: req, response: res });
  expect(captured.status, captured.body).toBe(200);
  return JSON.parse(captured.body) as SkillsResponse;
}

function extensionFor(contentDir: string, home: string) {
  return createApiExtension({
    contentDir,
    projectDir: contentDir,
    homeDirOverride: home,
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
  });
}

function unexpectedCall(): never {
  throw new Error('Unexpected recovery dependency call');
}

function makeJsonRequest(path: string, body: object): IncomingMessage {
  const base = makeSyntheticReq({ method: 'POST', url: path });
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: path,
    headers: { ...base.headers, 'content-type': 'application/json' },
    socket: base.socket,
  }) as IncomingMessage;
}

test('installed catalog TTL starts when a build longer than five seconds completes', () => {
  const fixture = seedFixture(false);
  const cache = newCache(fixture.home);
  fakeNow = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow ?? 0);
  startObservation(1_000);
  try {
    const first = cache.enumerateInstalledSkillsCached({
      home: fixture.home,
      projectDir: fixture.contentDir,
    });
    const completionTime = fakeNow;
    expect(completionTime - 100_000).toBeGreaterThan(5_000);
    expect(first.skills.filter((skill) => skill.name === 'fixture-skill')).toHaveLength(2);
    startObservation(1_000);
    const immediate = cache.enumerateInstalledSkillsCached({
      home: fixture.home,
      projectDir: fixture.contentDir,
    });
    const immediateWork = finishObservation();
    expect(immediate).toBe(first);
    expect(immediateWork.reads).toHaveLength(0);
    fakeNow = completionTime + 4_999;
    expect(
      cache.enumerateInstalledSkillsCached({
        home: fixture.home,
        projectDir: fixture.contentDir,
      }),
    ).toBe(first);
    fakeNow = completionTime + 5_000;
    expect(
      cache.enumerateInstalledSkillsCached({
        home: fixture.home,
        projectDir: fixture.contentDir,
      }),
    ).not.toBe(first);
  } finally {
    observation = null;
    fakeNow = null;
  }
});

test('plugin index TTL starts when a build longer than thirty seconds completes', () => {
  const fixture = seedFixture(false);
  const cache = newCache(fixture.home);
  fakeNow = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow ?? 0);
  startObservation(5_000);
  try {
    const first = cache.pluginSkillsByName(fixture.contentDir);
    const completionTime = fakeNow;
    expect(completionTime - 100_000).toBeGreaterThan(30_000);
    expect(first.get('fixture-skill')).toBeDefined();
    startObservation(5_000);
    const immediate = cache.pluginSkillsByName(fixture.contentDir);
    const immediateWork = finishObservation();
    expect(immediate).toBe(first);
    expect(immediateWork.reads).toHaveLength(0);
    fakeNow = completionTime + 29_999;
    expect(cache.pluginSkillsByName(fixture.contentDir)).toBe(first);
    fakeNow = completionTime + 30_000;
    expect(cache.pluginSkillsByName(fixture.contentDir)).not.toBe(first);
  } finally {
    observation = null;
    fakeNow = null;
  }
});

test('/api/skills keeps its catalog reusable by an immediate /api/skills/installed request', async () => {
  const fixture = seedFixture(true, 0);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  fakeNow = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow ?? 0);
  startObservation(1_000, fixture.bundleRoot);
  try {
    const listBody = await request(extension, '/api/skills');
    const listWork = finishObservation();
    expect(listBody.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
    );
    expect(fakeNow - 100_000).toBeGreaterThan(5_000);
    expect(versionsRead(listWork, fixture.bundleRoot)).toEqual([OWN_VERSION, USER_VERSION]);
    startObservation(1_000, fixture.bundleRoot);
    const installedBody = await request(extension, '/api/skills/installed');
    const installedWork = finishObservation();
    expect(installedBody.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
    );
    expect(versionsRead(installedWork, fixture.bundleRoot)).toEqual([]);
  } finally {
    observation = null;
    fakeNow = null;
  }
});

test('/api/skills reads and hashes only user and requesting-project plugin bundles', async () => {
  const baseline = seedFixture(true, 0);
  const fixture = seedFixture(true);
  const baselineExtension = extensionFor(baseline.contentDir, baseline.home);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  startObservation();
  const baselineBody = await request(baselineExtension, '/api/skills');
  const baselineWork = finishObservation();
  startObservation();
  const body = await request(extension, '/api/skills');
  const work = finishObservation();
  expect(baselineBody.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
  );
  expect(versionsRead(baselineWork, baseline.bundleRoot)).toEqual([OWN_VERSION, USER_VERSION]);
  expect(body.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
  );
  expect.soft(versionsRead(work, fixture.bundleRoot)).toEqual([OWN_VERSION, USER_VERSION]);
  expect.soft(work.reads).toHaveLength(baselineWork.reads.length);
  expect.soft(work.hashes).toBe(baselineWork.hashes);
});

test('/api/skills does not read a directory marketplace owned only by another project', async () => {
  const fixture = seedFixture(true, 0);
  const marketplaceManifest = addForeignDirectoryMarketplace(fixture);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  startObservation();
  const body = await request(extension, '/api/skills');
  const work = finishObservation();
  expect(body.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
  );
  expect(work.reads).not.toContain(marketplaceManifest);
});

test('/api/skills/installed reads metadata only for user and requesting-project plugin bundles', async () => {
  const baseline = seedFixture(false, 0);
  const fixture = seedFixture(false);
  const baselineExtension = extensionFor(baseline.contentDir, baseline.home);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  startObservation();
  const baselineBody = await request(baselineExtension, '/api/skills/installed');
  const baselineWork = finishObservation();
  startObservation();
  const body = await request(extension, '/api/skills/installed');
  const work = finishObservation();
  expect(baselineBody.skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({ scope: 'user' }),
      }),
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: baseline.contentDir,
        }),
      }),
    ]),
  );
  expect(versionsRead(baselineWork, baseline.bundleRoot)).toEqual([OWN_VERSION, USER_VERSION]);
  expect(body.skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({ scope: 'user' }),
      }),
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: fixture.contentDir,
        }),
      }),
    ]),
  );
  expect.soft(versionsRead(work, fixture.bundleRoot)).toEqual([OWN_VERSION, USER_VERSION]);
  expect.soft(work.reads).toHaveLength(baselineWork.reads.length);
  expect.soft(work.hashes).toBe(baselineWork.hashes);
});

test('/api/skills uses the canonical parent project registry site for a linked worktree', async () => {
  const baseline = seedLinkedFixture(true, false);
  const fixture = seedLinkedFixture(true, true);
  expectLinkedWorktreeParentIdentity(baseline);
  expectLinkedWorktreeParentIdentity(fixture);
  const baselineExtension = extensionFor(baseline.contentDir, baseline.home);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  startObservation();
  const baselineBody = await request(baselineExtension, '/api/skills');
  const baselineWork = finishObservation();
  startObservation();
  const body = await request(extension, '/api/skills');
  const work = finishObservation();
  expect(baselineBody.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
  );
  expect(versionsRead(baselineWork, baseline.bundleRoot)).toEqual([MAIN_VERSION, USER_VERSION]);
  expect(body.skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'fixture-skill' })]),
  );
  expect.soft(versionsRead(work, fixture.bundleRoot)).toEqual([MAIN_VERSION, USER_VERSION]);
  expect.soft(work.reads).toHaveLength(baselineWork.reads.length);
  expect.soft(work.hashes).toBe(baselineWork.hashes);
});

test('/api/skills/installed uses the canonical parent project registry site for a linked worktree', async () => {
  const baseline = seedLinkedFixture(false, false);
  const fixture = seedLinkedFixture(false, true);
  expectLinkedWorktreeParentIdentity(baseline);
  expectLinkedWorktreeParentIdentity(fixture);
  const baselineExtension = extensionFor(baseline.contentDir, baseline.home);
  const extension = extensionFor(fixture.contentDir, fixture.home);
  startObservation();
  const baselineBody = await request(baselineExtension, '/api/skills/installed');
  const baselineWork = finishObservation();
  startObservation();
  const body = await request(extension, '/api/skills/installed');
  const work = finishObservation();
  expect.soft(baselineBody.skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({ scope: 'user' }),
      }),
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: baseline.mainDir,
        }),
      }),
    ]),
  );
  expect(versionsRead(baselineWork, baseline.bundleRoot)).toEqual([MAIN_VERSION, USER_VERSION]);
  expect.soft(body.skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({ scope: 'user' }),
      }),
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: fixture.mainDir,
        }),
      }),
    ]),
  );
  expect.soft(body.skills).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: fixture.contentDir,
        }),
      }),
    ]),
  );
  expect.soft(body.skills).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'fixture-skill',
        provenance: expect.objectContaining({
          scope: 'project',
          projectPath: fixture.siblingDir,
        }),
      }),
    ]),
  );
  expect.soft(versionsRead(work, fixture.bundleRoot)).toEqual([MAIN_VERSION, USER_VERSION]);
  expect.soft(work.reads).toHaveLength(baselineWork.reads.length);
  expect.soft(work.hashes).toBe(baselineWork.hashes);
});

test('skill recovery resolves plugin origin from the canonical parent project registry site', async () => {
  const fixture = seedLinkedFixture(false, true);
  expectLinkedWorktreeParentIdentity(fixture);
  const name = 'fixture-skill';
  const skillsRoot = join(fixture.contentDir, '.claude', 'skills');
  const bundleDir = join(skillsRoot, name);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    join(bundleDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture\n---\n\nBody.\n`,
  );
  const synthPluginLockEntry = vi.fn(() => null);
  const group = createSkillsRecoveryRoutes({
    synthPluginLockEntry,
    synthBuiltinLockEntry: () => null,
    isValidSkillName: () => true,
    getPrincipal: undefined,
    validateSkillName: () => true,
    rejectReservedBuiltinSkill: () => false,
    shadowRef: undefined,
    contentDir: fixture.contentDir,
    contentRoot: undefined,
    projectDir: fixture.contentDir,
    skillsHome: join(fixture.home, '.claude', 'skills'),
    projectSkillDirRel: (skillName) => `.claude/skills/${skillName}`,
    attributeOkArtifactWrite: () => {},
    okArtifactKey: () => '',
    commitOkArtifactWrite: () => Promise.resolve(),
    signalChannel: undefined,
    bumpSkillsCatalogGen: () => {},
    contentFilter: undefined,
    scheduleDeferredIgnoreRebuild: () => {},
    effectiveSkillRoot: (_scope, skillName) => ({
      root: skillsRoot,
      dirRel: `.claude/skills/${skillName}`,
      realDir: join(skillsRoot, skillName),
    }),
    skillReimportService: { runSkillReimport: unexpectedCall },
    localSkillHash: () => undefined,
    resolveSkillsRoot: () => skillsRoot,
    projectImportedSkillCopy: unexpectedCall,
  });
  const dispatch = group.table.resolve('/api/skill/reimport')?.dispatch;
  expect(dispatch).toBeDefined();
  const { res, captured } = makeCaptureRes();
  await dispatch?.(makeJsonRequest('/api/skill/reimport', { name, scope: 'project' }), res);
  expect(captured.status, captured.body).toBe(400);
  expect(JSON.parse(captured.body)).toMatchObject({ detail: 'NOT_IMPORTED' });
  expect(synthPluginLockEntry).toHaveBeenCalledWith(name, fixture.mainDir, bundleDir);
});
