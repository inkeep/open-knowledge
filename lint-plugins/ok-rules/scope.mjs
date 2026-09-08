import { relative } from 'node:path';
import { globToRegExp, normalizeRelativePath } from '../no-comments/scope.mjs';

const CACHE = new Map();

function matches(glob, path) {
  let re = CACHE.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    CACHE.set(glob, re);
  }
  return re.test(path);
}

export const UNSCOPED_RULES = new Set([
  'microcopy-ellipsis',
  'no-hand-rolled-spinner',
  'no-loosely-typed-webcontents-ipc',
  'no-resolved-value-theme-source',
  'no-split-suggestion-dispatch',
  'no-unportaled-editor-content',
]);

export const RULE_SCOPES = {
  'no-raw-route-hash-construction': [
    'packages/app/src/**/*.ts',
    'packages/app/src/**/*.tsx',
    '!packages/app/src/lib/doc-hash.ts',
    '!**/*.test.ts',
    '!**/*.test.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-raw-route-hash-construction.fixture.tsx',
  ],
  'path-conditional-map-driven-origin': [
    'packages/server/src/server-observers.ts',
    'lint-plugins/ok-rules/__fixtures__/path-conditional-map-driven-origin.fixture.tsx',
  ],
  'cst-pm-handler-todo-stub': [
    'packages/md-conformance/src/substrates/*/handlers/**/*.ts',
    'lint-plugins/ok-rules/__fixtures__/cst-pm-handler-todo-stub.fixture.tsx',
  ],
  'class-proof-registration-discipline': [
    '**/*.ts',
    '**/*.tsx',
    '**/*.mts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/*.test.ts',
    '!**/*.test.tsx',
    '!**/*.test.mts',
    '!packages/md-conformance/src/class-proofs/proofs/**',
    'lint-plugins/ok-rules/__fixtures__/class-proof-registration-discipline.fixture.tsx',
  ],
  'require-windowshide-on-spawn': [
    'packages/server/src/**/*.ts',
    'packages/cli/src/**/*.ts',
    'packages/desktop/src/**/*.ts',
    '!**/*.test.ts',
    '!**/*.test-helper.ts',
    'lint-plugins/ok-rules/__fixtures__/require-windowshide-on-spawn.fixture.tsx',
  ],
  'require-utf8-multipart-parser': [
    '**/*.ts',
    '**/*.tsx',
    '**/*.mts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/*.test.ts',
    '!**/*.test.tsx',
    '!**/*.test.mts',
    '!**/*.test-helper.ts',
    '!packages/server/src/multipart.ts',
    'lint-plugins/ok-rules/__fixtures__/require-utf8-multipart-parser.fixture.tsx',
  ],
  'no-blind-agent-host-fanout': [
    'packages/server/src/**/*.ts',
    'packages/cli/src/**/*.ts',
    'lint-plugins/ok-rules/__fixtures__/no-blind-agent-host-fanout.fixture.tsx',
  ],
  'playwright-prefer-to-have-count': [
    'packages/app/tests/stress/**/*.e2e.ts',
    'packages/app/tests/visual/**/*.e2e.ts',
    'packages/app/tests/a11y/**/*.e2e.ts',
    'lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx',
  ],
  'no-uninstall-forbidden-import': [
    'packages/app/src/uninstall/**/*.ts',
    'packages/app/src/uninstall/**/*.tsx',
    '!packages/app/src/uninstall/**/*.test.ts',
    '!packages/app/src/uninstall/**/*.test.tsx',
    '!packages/app/src/uninstall/**/*.dom.test.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-uninstall-forbidden-import.fixture.tsx',
  ],
  'no-raw-html-interactive-element': [
    'packages/app/src/**/*.tsx',
    'packages/desktop/src/**/*.tsx',
    'packages/plugin/src/**/*.tsx',
    '!packages/app/src/editor/**',
    '!packages/app/src/components/ui/**',
    '!**/*.test.tsx',
    '!**/*.dom.test.tsx',
    '!**/*.test-helper.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-raw-html-interactive-element.fixture.tsx',
  ],
  'no-themeless-pierre-diff': [
    'packages/app/src/**/*.tsx',
    '!**/*.test.tsx',
    '!**/*.dom.test.tsx',
    '!**/*.test-helper.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-themeless-pierre-diff.fixture.tsx',
  ],
  'no-unwrapped-user-facing-string': [
    'packages/app/src/**/*.ts',
    'packages/app/src/**/*.tsx',
    'packages/desktop/src/**/*.ts',
    'packages/desktop/src/**/*.tsx',
    'packages/plugin/src/**/*.ts',
    'packages/plugin/src/**/*.tsx',
    '!packages/app/src/editor/**',
    '!packages/app/src/components/ui/**',
    '!packages/desktop/src/main/**',
    '!**/*.test.ts',
    '!**/*.test.tsx',
    '!**/*.dom.test.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx',
  ],
  'no-physical-direction-utility': [
    'packages/app/src/**/*.tsx',
    'packages/desktop/src/**/*.tsx',
    'packages/plugin/src/**/*.tsx',
    '!packages/app/src/editor/**',
    '!packages/app/src/components/ui/**',
    '!**/*.test.tsx',
    '!**/*.dom.test.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx',
  ],
  'no-demoted-dialog-confirm': [
    'packages/app/src/**/*.tsx',
    'packages/desktop/src/**/*.tsx',
    'packages/plugin/src/**/*.tsx',
    '!packages/app/src/components/ui/**',
    '!**/*.test.tsx',
    '!**/*.dom.test.tsx',
    'lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx',
  ],
  'no-roundtrip-identity-oracle': [
    'packages/**/*.test.ts',
    'packages/**/*.test.tsx',
    'packages/**/*.e2e.ts',
    '!packages/md-conformance/**',
    '!packages/app/tests/fidelity/**',
    '!packages/core/src/markdown/**/*.test.ts',
    '!packages/core/src/bridge/**/*.test.ts',
    '!**/*.private.*',
    'lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx',
  ],
  'no-inline-tolerance-class': [
    'packages/**/*.test.ts',
    'packages/**/*.test.tsx',
    'packages/**/*.e2e.ts',
    '!packages/md-conformance/**',
    '!packages/app/tests/fidelity/**',
    '!packages/core/src/markdown/**/*.test.ts',
    '!packages/core/src/bridge/**/*.test.ts',
    '!**/*.private.*',
    'lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx',
  ],
};

export function isInScope(ruleName, relPath, table = RULE_SCOPES) {
  const globs = table[ruleName];
  if (!globs) {
    if (table === RULE_SCOPES && UNSCOPED_RULES.has(ruleName)) return true;
    throw new Error(
      `ok-rules: rule '${ruleName}' has no entry in the scope table it was looked up in, ` +
        'and is not in UNSCOPED_RULES. Add it to one. Defaulting to in-scope-everywhere would ' +
        'silently widen a scoped rule across the whole tree.',
    );
  }
  const path = normalizeRelativePath(relPath);
  let included = false;
  for (const glob of globs) {
    if (glob.startsWith('!')) {
      if (matches(glob.slice(1), path)) return false;
    } else if (!included && matches(glob, path)) {
      included = true;
    }
  }
  return included;
}

function scopedFilename(context, repoRoot) {
  const absolute = context.physicalFilename ?? context.filename;
  return normalizeRelativePath(relative(repoRoot, absolute));
}

export function scoped(ruleName, rule, repoRoot, table = RULE_SCOPES) {
  return {
    ...rule,
    create(context) {
      if (!isInScope(ruleName, scopedFilename(context, repoRoot), table)) return {};
      return rule.create(context);
    },
  };
}
