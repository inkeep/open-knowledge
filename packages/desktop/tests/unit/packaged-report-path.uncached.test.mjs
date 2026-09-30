import { sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PACKAGED_REPORT } from '../../../../.github/scripts/smoke-packaged-dmg.mjs';
import { PACKAGED_JSON_REPORT_PATH } from '../../playwright.packaged.config.ts';

describe('packaged report path', () => {
  test('the release driver and the Playwright config name the same file', () => {
    expect(PACKAGED_REPORT.split(sep).join('/')).toBe(PACKAGED_JSON_REPORT_PATH);
  });

  test('and that file is the one the workflow reads', () => {
    expect(PACKAGED_JSON_REPORT_PATH).toBe('test-results/desktop-smoke-packaged-results.json');
  });
});
