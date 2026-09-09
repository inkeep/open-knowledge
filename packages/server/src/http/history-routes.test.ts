import { isValidBranchName } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import type { ShadowHandle, ShadowRef } from '../shadow-repo.ts';
import { createHistoryRoutes } from './history-routes.ts';

type Deps = Parameters<typeof createHistoryRoutes>[0];

const ADMITTED = 'branch admitted: the request reached the next validation stage';

function buildGroup(overrides: Partial<Deps> = {}) {
  const shadowRef: ShadowRef = { current: {} as ShadowHandle };
  return createHistoryRoutes({
    contentRoot: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    shadowRef,
    flushGitCommit: undefined,
    commitOkArtifactWrite: () => Promise.resolve(),
    getCurrentBranch: undefined,
    validateFolderRel: (_raw, res) => {
      res.writeHead(400, { 'Content-Type': 'application/problem+json' });
      res.end(
        JSON.stringify({ type: 'urn:ok:error:invalid-request', title: ADMITTED, status: 400 }),
      );
      return null;
    },
    safeDocPath: () => ({ error: ADMITTED }),
    docTreePathCandidates: () => [],
    ...overrides,
  });
}

interface HistoryOutcome {
  status: number;
  type: string;
  title: string;
  contentType: string;
  admitted: boolean;
}

async function dispatchHistory(path: string, overrides: Partial<Deps>): Promise<HistoryOutcome> {
  const { table } = buildGroup(overrides);
  const resolved = table.resolve(path.split('?')[0] ?? path);
  if (!resolved?.dispatch) throw new Error(`${path} did not resolve to a dispatch handler`);
  const { res, captured } = makeCaptureRes();
  await resolved.dispatch(makeSyntheticReq({ url: path }), res);
  const body = captured.body
    ? (JSON.parse(captured.body) as { type?: string; title?: string })
    : {};
  const title = body.title ?? '';
  return {
    status: captured.status,
    type: body.type ?? '',
    title,
    contentType: String(captured.headers['content-type'] ?? ''),
    admitted: title === ADMITTED,
  };
}

function getHistory(query: string, overrides: Partial<Deps> = {}): Promise<HistoryOutcome> {
  return dispatchHistory(`/api/history?${query}`, overrides);
}

function getHistoryForBranch(
  branch: string,
  overrides: Partial<Deps> = {},
): Promise<HistoryOutcome> {
  return getHistory(`docName=alpha&branch=${encodeURIComponent(branch)}`, overrides);
}

const PLUS_BRANCH = 'worktree-design+atc-release-package';
const NBSP_BRANCH = 'feature\u00A0nbsp';

const GIT_LEGAL_BRANCH_NAMES = [
  PLUS_BRANCH,
  'release(2026)#1',
  'feat/issue=42',
  'feat/a,b',
  'feat/100%-done',
  'feat/cost$estimate',
  'feat/this&that',
  'feat/ship!now',
  'feat/a;b',
  "feat/miles'-branch",
  '_leading-underscore',
  'feature-café',
  'функция-тест',
  'main',
] as const;

const GIT_ILLEGAL_BUT_CONTRACT_ADMITTED = [
  'feat/a~b',
  'feat/a^b',
  'feat/a?b',
  'feat/a*b',
  'feat/a[b',
  'feat/a\\b',
  'feat/a@{b',
  'x.lock',
  '.hidden',
  'feat//x',
  'feat/',
  'feat/a..b',
] as const;

const CONTRACT_REJECTED_BRANCH_NAMES = [
  '../evil',
  NBSP_BRANCH,
  'a/../../heads/main',
  '-oInject',
  'has space',
  'has:colon',
  'ctrl\u0001char',
  'nul\u0000byte',
  '',
] as const;

describe('GET /api/history branch admission — names the shared contract accepts', () => {
  test.each(GIT_LEGAL_BRANCH_NAMES)('admits %j from the branch query parameter', async (branch) => {
    expect(isValidBranchName(branch)).toBe(true);
    const outcome = await getHistoryForBranch(branch);
    expect(outcome.title).toBe(ADMITTED);
  });

  test('admits the document Timeline shape: no branch parameter, head watcher on a "+" branch', async () => {
    const outcome = await getHistory('docName=alpha&limit=100', {
      getCurrentBranch: () => PLUS_BRANCH,
    });
    expect(outcome.title).toBe(ADMITTED);
  });

  test('admits the folder Timeline shape: no branch parameter, head watcher on a "+" branch', async () => {
    const outcome = await getHistory('folder=notes&limit=50', {
      getCurrentBranch: () => PLUS_BRANCH,
    });
    expect(outcome.title).toBe(ADMITTED);
  });
});

describe('GET /api/history branch admission — names the shared contract rejects', () => {
  test.each(CONTRACT_REJECTED_BRANCH_NAMES)(
    'rejects %j with the invalid-request envelope',
    async (branch) => {
      expect(isValidBranchName(branch)).toBe(false);
      const outcome = await getHistoryForBranch(branch);
      expect(outcome.admitted).toBe(false);
      expect(outcome.status).toBe(400);
      expect(outcome.type).toBe('urn:ok:error:invalid-request');
      expect(outcome.contentType).toBe('application/problem+json');
    },
  );

  test('rejects an argv-injecting branch arriving from the head watcher, not only from query', async () => {
    const outcome = await getHistory('docName=alpha', { getCurrentBranch: () => '-oInject' });
    expect(outcome.admitted).toBe(false);
    expect(outcome.status).toBe(400);
    expect(outcome.type).toBe('urn:ok:error:invalid-request');
  });
});

describe('GET /api/history branch admission — agreement with the declared contract', () => {
  test('admission decision matches isValidBranchName for every sampled name', async () => {
    const sampled = [...GIT_LEGAL_BRANCH_NAMES, ...CONTRACT_REJECTED_BRANCH_NAMES, 'feat/a..b'];
    const admission: Record<string, boolean> = {};
    const contract: Record<string, boolean> = {};
    for (const branch of sampled) {
      admission[branch] = (await getHistoryForBranch(branch)).admitted;
      contract[branch] = isValidBranchName(branch);
    }
    expect(admission).toEqual(contract);
  });

  test('admits "feat/a..b": the contract rejects ".." only as a whole path segment', async () => {
    expect(isValidBranchName('feat/a..b')).toBe(true);
    const outcome = await getHistoryForBranch('feat/a..b');
    expect(outcome.title).toBe(ADMITTED);
  });
});

describe('GET /api/history branch admission — names git rejects that the contract admits', () => {
  test.each(GIT_ILLEGAL_BUT_CONTRACT_ADMITTED)(
    'admits %j, which `git check-ref-format` rejects',
    async (branch) => {
      expect(isValidBranchName(branch)).toBe(true);
      const outcome = await getHistoryForBranch(branch);
      expect(outcome.title).toBe(ADMITTED);
    },
  );
});
