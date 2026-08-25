import { sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PACKAGED_REPORT } from '../../../../.github/scripts/smoke-packaged-dmg.mjs';
import { PACKAGED_JSON_REPORT_PATH } from '../../playwright.packaged.config.ts';

/**
 * The release driver hardcodes the packaged report path; the config owns it.
 * Nothing in the type system relates the two, and the release workflow overlays
 * the driver while pinning the config to a tag, so they can move apart.
 *
 * The trap is specific: per-test ARTIFACTS go to `test-results-packaged/` while
 * the JSON report deliberately stays in `test-results/`, which makes "align the
 * driver with the artifact tree" a plausible and wrong edit.
 *
 * This lives in `packages/desktop/tests/unit/` because both values are real
 * here — the config is imported by `playwright-packaged-config.test.ts` in this
 * directory, and `verify-native-config-driver.test.mjs` beside it already
 * reaches a `.mjs` driver four levels up. Comparing values rather than reading
 * either as source keeps the guard blind to formatting: hoisting a literal into
 * a call, a template literal, or a type annotation changes no path and must not
 * fail this.
 */
describe('packaged report path', () => {
  test('the release driver and the Playwright config name the same file', () => {
    // `join` yields the platform separator; the config declares POSIX.
    expect(PACKAGED_REPORT.split(sep).join('/')).toBe(PACKAGED_JSON_REPORT_PATH);
  });

  test('and that file is the one the workflow reads', () => {
    // A coordinated rename of both sides would satisfy the equality above while
    // leaving the third copy — hardcoded in the desktop-smoke vacuity step —
    // pointing at a report nobody writes.
    expect(PACKAGED_JSON_REPORT_PATH).toBe('test-results/desktop-smoke-packaged-results.json');
  });
});
