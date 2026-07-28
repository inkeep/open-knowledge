import { describe, expect, test } from 'vitest';
import { wrapperPathInBundle } from './bundle-paths.ts';

describe('wrapperPathInBundle', () => {
  test('maps packaged executable path to bundled ok.sh wrapper', () => {
    // Platform pinned: the parameter defaults to process.platform (correct
    // for the production call sites, host-dependent in tests — the CI test
    // host is Linux). Per-platform layouts are covered in install-shape.test.ts.
    expect(
      wrapperPathInBundle('/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge', 'darwin'),
    ).toBe('/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh');
  });
});
