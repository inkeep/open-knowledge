import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { makeCaptureRes } from '../composition-rig.test-helper.ts';
import { OK_DOC_REMOVED } from '../document-durability-state.ts';
import { loggerFactory } from '../logger.ts';
import { createSkillsInstallRoutes, type SkillsInstallRouteDeps } from './skills-install-routes.ts';

const INSTALL_PATH = '/api/skill/install';

function unexpectedCall(): never {
  throw new Error('Route table construction must not invoke skill services.');
}

function buildGroup(overrides: Partial<SkillsInstallRouteDeps> = {}) {
  return createSkillsInstallRoutes({
    resolveSkillsRoot: () => '/nonexistent-skills',
    validateSkillName: () => true,
    projectDir: undefined,
    skillInstallBase: () => undefined,
    contentDir: '/nonexistent-content',
    skillsHome: '/nonexistent-skills-home',
    shippedBundleSkillMd: () => null,
    flushDiskAndDetectOutcome: () => Promise.resolve(null),
    respondStaleExternalWrite: unexpectedCall,
    respondPersistenceFailure: unexpectedCall,
    respondDiskDivergence: unexpectedCall,
    skillInstallOps: {
      resolveFork: unexpectedCall,
      applyAddRemove: unexpectedCall,
      promoteStoreBackedSource: unexpectedCall,
      promoteInPlaceSource: unexpectedCall,
      fanOutInPlace: unexpectedCall,
    },
    skillPlacementOps: {
      place: unexpectedCall,
      unplace: unexpectedCall,
      convert: unexpectedCall,
    },
    signalChannel: undefined,
    bumpSkillsCatalogGen: () => {},
    contentFilter: undefined,
    scheduleDeferredIgnoreRebuild: () => {},
    effectiveInstallMode: () => 'copy',
    log: loggerFactory.getLogger('test'),
    ...overrides,
  });
}

describe('createSkillsInstallRoutes table', () => {
  test('registers exactly the one skill-install path', () => {
    expect([...buildGroup().paths].sort()).toEqual([INSTALL_PATH].sort());
  });

  test('every skill-install path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of [INSTALL_PATH]) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = INSTALL_PATH;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

describe('skill-install surfaces every flush outcome instead of installing over it', () => {
  const SKILL_NAME = 'probe-skill';
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  function seedSourcelessSkill() {
    const skillsRoot = mkdtempSync(join(tmpdir(), 'ok-skill-install-root-'));
    const skillsHome = mkdtempSync(join(tmpdir(), 'ok-skill-install-home-'));
    roots.push(skillsRoot, skillsHome);
    mkdirSync(join(skillsRoot, SKILL_NAME), { recursive: true });
    return { skillsRoot, skillsHome };
  }

  async function dispatchInstall(overrides: Partial<SkillsInstallRouteDeps>) {
    const { skillsRoot, skillsHome } = seedSourcelessSkill();
    const group = buildGroup({
      resolveSkillsRoot: () => skillsRoot,
      skillsHome,
      skillInstallBase: () => skillsHome,
      ...overrides,
    });
    const route = group.table.resolve(INSTALL_PATH);
    if (!route?.dispatch) throw new Error(`${INSTALL_PATH} did not resolve to a dispatch handler`);
    const { res, captured } = makeCaptureRes();
    await route.dispatch(makeReq({ name: SKILL_NAME, scope: 'global' }), res);
    return captured;
  }

  test('a refused disk write answers with the failure rather than validating and installing', async () => {
    const seen: unknown[] = [];
    const captured = await dispatchInstall({
      flushDiskAndDetectOutcome: () =>
        Promise.resolve({
          kind: 'failure',
          failure: { code: OK_DOC_REMOVED, message: 'the skill document is no longer on disk' },
        }),
      respondPersistenceFailure: (res, failure, handler) => {
        seen.push({ failure, handler });
        res.writeHead(409, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'urn:ok:error:doc-removed' }));
      },
    });
    expect(seen).toEqual([
      {
        failure: { code: OK_DOC_REMOVED, message: 'the skill document is no longer on disk' },
        handler: 'skill-install',
      },
    ]);
    expect(captured.status).toBe(409);
    expect(captured.body).not.toContain('INVALID_SKILL_SOURCE');
  });

  test('a diverged disk write answers with the divergence rather than validating and installing', async () => {
    const seen: string[] = [];
    const captured = await dispatchInstall({
      flushDiskAndDetectOutcome: () => Promise.resolve({ kind: 'divergence' }),
      respondDiskDivergence: (res, handler) => {
        seen.push(handler);
        res.writeHead(409, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'urn:ok:error:disk-divergence' }));
      },
    });
    expect(seen).toEqual(['skill-install']);
    expect(captured.status).toBe(409);
    expect(captured.body).not.toContain('INVALID_SKILL_SOURCE');
  });

  test('a clean flush falls through to validation, which rejects a SKILL.md-less source', async () => {
    const captured = await dispatchInstall({});
    expect(captured.status).toBe(400);
    expect(captured.body).toContain('INVALID_SKILL_SOURCE');
  });
});
