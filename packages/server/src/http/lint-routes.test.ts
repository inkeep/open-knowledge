import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { isValidRelativeContentPath } from '../relative-content-path.ts';
import { createLintRoutes } from './lint-routes.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('audit routes with a missing content directory', () => {
  test.each(['/api/lint/audit', '/api/audit'])(
    '%s reports missing root and child scopes while rejecting explicit dot paths',
    async (routePath) => {
      const projectDir = mkdtempSync(join(tmpdir(), 'ok-missing-audit-route-'));
      roots.push(projectDir);
      const contentDir = join(projectDir, 'missing-content');
      const group = createLintRoutes({
        hocuspocus: new Hocuspocus({ quiet: true }),
        contentDir,
        projectDir,
        contentFilter: undefined,
        isSafeDocName: () => true,
        resolveDocFilePath: () => null,
        isValidRelativeContentPath,
        async *streamShowAllEntries() {
          yield* [];
          return { truncated: false };
        },
        getLinterBaseConfig: undefined,
        getLinkAdvisoryPolicy: () => ({ links: 'off', suppressLogLinkAdvisories: false }),
        derivedDocumentIndex: undefined,
        collectAdmittedDocNames: async () => new Set<string>(),
        unmatchedGlobProblems: () => [],
        readAuditGeneration: () => 'initial',
        localTargetInventory: () => ({ documentTargets: [], fileTargets: [], folderTargets: [] }),
      });
      const dispatch = group.table.resolve(routePath)?.dispatch;
      if (dispatch === undefined) throw new Error(`${routePath} was not registered`);
      const rootResponse = makeCaptureRes();
      await dispatch(makeSyntheticReq({ url: routePath }), rootResponse.res);
      expect(rootResponse.captured.status).toBe(404);
      expect(rootResponse.captured.headers['content-type']).toContain('application/problem+json');
      expect(JSON.parse(rootResponse.captured.body)).toMatchObject({
        type: 'urn:ok:error:not-found',
        status: 404,
        title: expect.stringContaining('Set content.dir to an existing directory.'),
      });
      const dotResponse = makeCaptureRes();
      await dispatch(makeSyntheticReq({ url: `${routePath}?path=.` }), dotResponse.res);
      expect(dotResponse.captured.status).toBe(400);
      expect(JSON.parse(dotResponse.captured.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        status: 400,
        title: 'Invalid path.',
      });
      mkdirSync(contentDir);
      const { res, captured } = makeCaptureRes();
      await dispatch(makeSyntheticReq({ url: `${routePath}?path=child` }), res);
      expect(captured.status).toBe(404);
      expect(JSON.parse(captured.body)).toMatchObject({
        type: 'urn:ok:error:not-found',
        title: expect.stringContaining('Use an existing file or directory'),
      });
    },
  );
});
