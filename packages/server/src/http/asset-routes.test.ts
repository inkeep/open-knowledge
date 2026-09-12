import { describe, expect, test } from 'vitest';
import { loggerFactory } from '../logger.ts';
import { createAssetService } from '../services/assets.ts';
import { createAssetRoutes } from './asset-routes.ts';

const paths = ['/api/asset', '/api/asset-text'];

describe('asset read route table', () => {
  test('owns exactly the two non-mutating read routes', () => {
    const group = createAssetRoutes({
      assetService: createAssetService({ contentDir: '/nonexistent-assets' }),
      log: loggerFactory.getLogger('test'),
    });
    expect(group.paths).toEqual(paths);
    for (const path of paths) {
      expect(group.table.resolve(path)?.dispatch).toBeTypeOf('function');
      expect(group.table.isMutating(path)).toBe(false);
      expect(group.table.resolve(`${path}/`)).toBeNull();
    }
  });
});
