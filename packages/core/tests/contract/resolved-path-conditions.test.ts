import * as viaPackageName from '@inkeep/open-knowledge-core';
import { expect, test } from 'vitest';
import * as viaSource from '../../src/index.ts';

test('the package-name import resolves to src/ (development condition), not dist/', () => {
  expect(viaSource.MarkdownManager).toBeDefined();
  expect(viaSource.sharedExtensions).toBeDefined();
  expect(viaPackageName.MarkdownManager).toBe(viaSource.MarkdownManager);
  expect(viaPackageName.sharedExtensions).toBe(viaSource.sharedExtensions);
});
