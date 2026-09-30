import { describe, expect, test } from 'vitest';
import serverConfig from '../tsdown.config';

const MUST_INLINE_DEPS = ['pino', 'pino-pretty'] as const;

function matchesBundleRule(rules: unknown, id: string): boolean {
  if (!Array.isArray(rules) || !rules.every((rule: unknown) => rule instanceof RegExp)) {
    throw new TypeError(`alwaysBundle for ${id} must be an array of RegExp rules`);
  }
  return rules.some((rule) => new RegExp(rule).test(id));
}

describe('tsdown alwaysBundle covers server logger deps', () => {
  test.each(MUST_INLINE_DEPS)('bundles %s and its subpaths', (dep) => {
    const diagnostic =
      `Add /^${dep}(\\/|$)/ to packages/server/tsdown.config.ts alwaysBundle. ` +
      `A bare import '${dep}' fails with ERR_MODULE_NOT_FOUND from app.asar.unpacked/ ` +
      'in the packaged app if the server is relocated, the same bug class as #1389.';
    expect(matchesBundleRule(serverConfig.deps?.alwaysBundle, dep), diagnostic).toBe(true);
    expect(matchesBundleRule(serverConfig.deps?.alwaysBundle, `${dep}/subpath`), diagnostic).toBe(
      true,
    );
    for (const unrelated of [`${dep}-unrelated`, `x-${dep}`]) {
      expect(
        matchesBundleRule(serverConfig.deps?.alwaysBundle, unrelated),
        `Anchor the ${dep} alwaysBundle rule to the package root or a subpath. ${diagnostic}`,
      ).toBe(false);
    }
  });
});
