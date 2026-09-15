import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import simpleGit from 'simple-git';
import { describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import {
  createTestConflictAuthority,
  createTestConflictAuthorityInTmpDir,
} from '../conflict-authority.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import { createSyncRoutes } from './sync-routes.ts';

const makeAuthority = createTestConflictAuthority;

function emptyAuthority(): ConflictAuthority {
  return createTestConflictAuthorityInTmpDir('sync-routes-authority-');
}

function buildGroup() {
  return createSyncRoutes({
    projectDir: undefined,
    contentDir: '/tmp/ok-sync-routes-test',
    getPrincipal: undefined,
    hocuspocus: new Hocuspocus({ quiet: true }),
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    getSyncEngine: undefined,
    conflicts: emptyAuthority(),
    serializeDoc: undefined,
    setBatchInProgress: undefined,
  });
}

describe('createSyncRoutes table', () => {
  test('registers exactly the six sync paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/sync/status',
        '/api/sync/trigger',
        '/api/sync/conflicts',
        '/api/sync/conflict-content',
        '/api/sync/resolve-conflict',
        '/api/sync/resolve-blocking',
      ].sort(),
    );
  });

  test('the trigger/resolve trio is mutating; the three reads are not', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/sync/trigger',
      '/api/sync/resolve-conflict',
      '/api/sync/resolve-blocking',
    ]) {
      expect(table.isMutating(path), path).toBe(true);
    }
    for (const path of ['/api/sync/status', '/api/sync/conflicts', '/api/sync/conflict-content']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

describe('conflict-content working-tree ours-read errno discrimination', () => {
  function buildConflictGroup(projectDir: string) {
    const conflicts = makeAuthority(projectDir);
    conflicts.raise({ kind: 'working-tree', file: 'a.md', theirsSha: '' });
    return createSyncRoutes({
      projectDir,
      contentDir: '/tmp/ok-sync-routes-test',
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: undefined,
      conflicts,
      serializeDoc: undefined,
      setBatchInProgress: undefined,
    });
  }

  async function dispatchConflictContent(
    projectDir: string,
  ): Promise<{ status: number; body: string }> {
    const resolved = buildConflictGroup(projectDir).table.resolve('/api/sync/conflict-content');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/conflict-content');
    const req = makeSyntheticReq({ url: '/api/sync/conflict-content?file=a.md' });
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(req, res);
    return captured;
  }

  test('a genuinely absent working-tree file is the delete overlay (200 delete-modify)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-enoent-'));
    try {
      const captured = await dispatchConflictContent(projectDir);
      expect(captured.status).toBe(200);
      expect((JSON.parse(captured.body) as { kind?: string }).kind).toBe('delete-modify');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a non-ENOENT ours-read failure is a 500, never a silent delete-modify', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-eisdir-'));
    try {
      mkdirSync(join(projectDir, 'a.md'));
      const captured = await dispatchConflictContent(projectDir);
      expect(captured.status).toBe(500);
      expect((JSON.parse(captured.body) as { type?: string }).type).toBe(
        'urn:ok:error:internal-server-error',
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

const MARKERED = [
  '# Pricing',
  '',
  '<<<<<<< ours',
  'ours side',
  '=======',
  'theirs side',
  '>>>>>>> theirs',
  '',
].join('\n');

describe('resolve-conflict 422 discriminates strategy refusal from marker content', () => {
  function makePostReq(body: unknown): IncomingMessage {
    const req = Readable.from([
      Buffer.from(JSON.stringify(body), 'utf-8'),
    ]) as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/sync/resolve-conflict';
    req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
    req.socket = { remoteAddress: '127.0.0.1' } as unknown as IncomingMessage['socket'];
    return req;
  }

  async function dispatchResolve(
    projectDir: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; parsed: Record<string, unknown> }> {
    const conflicts = makeAuthority(projectDir);
    conflicts.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'disk-markers',
      stages: { base: 'B', ours: 'O', theirs: MARKERED },
    });
    const group = createSyncRoutes({
      projectDir,
      contentDir: projectDir,
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: undefined,
      conflicts,
      serializeDoc: undefined,
      setBatchInProgress: undefined,
    });
    const resolved = group.table.resolve('/api/sync/resolve-conflict');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/resolve-conflict');
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(makePostReq(body), res);
    return { status: captured.status, parsed: JSON.parse(captured.body) };
  }

  test('a strategy the conflict never offered is refused as a strategy problem', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-resolve-strategy-'));
    try {
      const { status, parsed } = await dispatchResolve(projectDir, {
        file: 'a.md',
        strategy: 'theirs',
      });

      expect(status).toBe(422);
      expect(parsed.refusal).toBe('strategy-not-offered');
      expect(parsed.resolutionOptions).toEqual(['mine', 'content', 'delete']);
      expect(parsed.title).toBe('Strategy not offered for this conflict.');
      expect(parsed.detail).toContain('"theirs"');
      expect(parsed.detail).not.toContain('still contains');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('submitted content that still carries markers is refused as a content problem', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-resolve-markers-'));
    try {
      const { status, parsed } = await dispatchResolve(projectDir, {
        file: 'a.md',
        strategy: 'content',
        content: MARKERED,
      });

      expect(status).toBe(422);
      expect(parsed.refusal).toBe('markers-in-content');
      expect(parsed.resolutionOptions).toEqual(['mine', 'content', 'delete']);
      expect(parsed.title).toBe('Resolution still contains conflict markers.');
      expect(parsed.detail).toContain('still contains');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('resolve-conflict brackets the resolve with the batch flag the server wires in', () => {
  function makePostReq(body: unknown): IncomingMessage {
    const req = Readable.from([
      Buffer.from(JSON.stringify(body), 'utf-8'),
    ]) as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/sync/resolve-conflict';
    req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
    req.socket = { remoteAddress: '127.0.0.1' } as unknown as IncomingMessage['socket'];
    return req;
  }

  async function dispatchResolve(
    projectDir: string,
    body: Record<string, unknown>,
    trace: string[],
  ): Promise<number> {
    const conflicts = makeAuthority(projectDir);
    conflicts.raise({
      kind: 'reconcile',
      file: 'a.md',
      reason: 'merged-with-markers',
      stages: { base: 'B', ours: 'OURS\n', theirs: 'THEIRS\n' },
    });
    const group = createSyncRoutes({
      projectDir,
      contentDir: projectDir,
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: undefined,
      conflicts,
      serializeDoc: undefined,
      setBatchInProgress: (value) => {
        trace.push(value ? 'batch-raised' : 'batch-lowered');
      },
    });
    const resolved = group.table.resolve('/api/sync/resolve-conflict');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/resolve-conflict');
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(makePostReq(body), res);
    return captured.status;
  }

  test('a successful resolve raises then lowers the batch flag', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-resolve-drain-'));
    try {
      const trace: string[] = [];
      const status = await dispatchResolve(projectDir, { file: 'a.md', strategy: 'mine' }, trace);

      expect(status).toBe(200);
      expect(trace).toEqual(['batch-raised', 'batch-lowered']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a refused resolve lowers the batch flag, never leaving it raised', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-resolve-drain-refused-'));
    try {
      const trace: string[] = [];
      const status = await dispatchResolve(
        projectDir,
        { file: 'a.md', strategy: 'content', content: MARKERED },
        trace,
      );

      expect(status).toBe(422);
      expect(trace).toEqual(['batch-raised', 'batch-lowered']);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('conflict-content dispatches per conflict kind', () => {
  async function dispatchContent(
    projectDir: string,
    seed: (conflicts: ConflictAuthority) => void,
    options: { liveOurs?: string; source?: 'ytext' } = {},
  ): Promise<{ status: number; body: string }> {
    const conflicts = makeAuthority(projectDir);
    seed(conflicts);
    const group = createSyncRoutes({
      projectDir,
      contentDir: projectDir,
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: undefined,
      conflicts,
      serializeDoc: options.liveOurs === undefined ? undefined : () => options.liveOurs ?? '',
      setBatchInProgress: undefined,
    });
    const resolved = group.table.resolve('/api/sync/conflict-content');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/conflict-content');
    const source = options.source === undefined ? '' : `&source=${options.source}`;
    const req = makeSyntheticReq({ url: `/api/sync/conflict-content?file=a.md${source}` });
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(req, res);
    return captured;
  }

  test('a reconcile entry answers from its captured stages without touching git', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-reconcile-'));
    try {
      const captured = await dispatchContent(projectDir, (conflicts) => {
        conflicts.raise({
          kind: 'reconcile',
          file: 'a.md',
          reason: 'merged-with-markers',
          stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
        });
      });

      expect(captured.status).toBe(200);
      expect(JSON.parse(captured.body)).toMatchObject({
        file: 'a.md',
        base: 'BASE\n',
        ours: 'OURS\n',
        theirs: 'THEIRS\n',
        conflict: 'reconcile',
        reason: 'merged-with-markers',
        kind: 'both-modified',
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a reconcile entry answers from marker-free Y.Text only when requested', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-live-reconcile-'));
    try {
      const captured = await dispatchContent(
        projectDir,
        (conflicts) => {
          conflicts.raise({
            kind: 'reconcile',
            file: 'a.md',
            reason: 'merged-with-markers',
            stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
          });
        },
        { liveOurs: 'LIVE\n', source: 'ytext' },
      );

      expect(captured.status).toBe(200);
      expect(JSON.parse(captured.body)).toMatchObject({ ours: 'LIVE\n' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a merge-native entry goes to the git stage reader', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-merge-native-'));
    try {
      const git = simpleGit(projectDir);
      await git.init(['--initial-branch=main']);
      await git.raw('config', 'user.name', 'Test');
      await git.raw('config', 'user.email', 'test@test.com');
      writeFileSync(join(projectDir, 'a.md'), 'tracked\n', 'utf-8');
      await git.add('.');
      await git.commit('seed');
      const captured = await dispatchContent(projectDir, (conflicts) => {
        conflicts.raise({ kind: 'merge-native', file: 'a.md' });
      });

      expect(captured.status).toBe(200);
      expect(JSON.parse(captured.body)).toMatchObject({
        file: 'a.md',
        conflict: 'merge-native',
        kind: 'both-modified',
        resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
