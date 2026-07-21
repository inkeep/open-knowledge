import { defineConfig } from 'oxlint';

// Applied in the base config AND re-declared in the *.test.* override below
// (oxlint replaces, rather than merges, a rule's options per override) so the
// require() ban can be added for test files without silently dropping these.
const restrictedSyntax = [
  {
    selector:
      "CallExpression[callee.name='useEffect'] UnaryExpression[operator='typeof'] > Identifier[name='window']",
    message:
      "Do not use `typeof window !== 'undefined'` inside useEffect; useEffect already runs client-side.",
  },
  {
    selector:
      "CallExpression[callee.name='useLayoutEffect'] UnaryExpression[operator='typeof'] > Identifier[name='window']",
    message:
      "Do not use `typeof window !== 'undefined'` inside useLayoutEffect; useLayoutEffect already runs client-side.",
  },
];

// Test files execute as ES modules, where a CommonJS `require()` is not
// defined. Calls like `require('./foo.ts')` or `require('node:fs')` break (or
// resolve inconsistently) at runtime. Use a static `import`, `await import()`,
// or `createRequire(import.meta.url)` for a native/CJS addon. The second
// selector also catches member calls like `require.resolve(...)`. Since both
// selectors key on the literal name `require`, binding a `createRequire` result
// to any other name (e.g. `require_`) keeps the escape hatch available without
// re-tripping either pattern.
const noRequireInTests = {
  selector: "CallExpression[callee.name='require'], CallExpression[callee.object.name='require']",
  message:
    'require() is not available in an ESM test module. Use a static import or await import(); for a native/CJS addon use createRequire(import.meta.url) bound to a name other than "require" (e.g. require_).',
};

export default defineConfig({
  // The .agents/skills, .codex/skills entries under
  // public/open-knowledge/ are real directories of per-skill symlinks back
  // to the repo-root canonical at ../../../.agents/skills/<skill>. Without
  // these excludes oxlint traverses through the symlinks and lints files
  // owned by inkeep/team-skills upstream (e.g. SSEClientTransport usage in
  // .agents/skills/code-mode/scripts/mcp-client.ts trips the no-deprecated
  // rule). Skill formatting is owned by cross-harness-skills-sync, not by
  // this repo's lint pass.
  // `/reports/**` (root-anchored) excludes the repo-root reports/ tree from
  // linting. Those are frozen spike-investigation artifacts (throwaway driver
  // scripts captured as evidence), not maintained source — they are already
  // excluded from PR review and from the public mirror, and biome likewise
  // excludes them via `!reports` in biome.jsonc. They trip unused-vars /
  // unicorn style rules that don't apply to one-shot evidence scripts.
  ignorePatterns: ['.agents/skills/**', '.codex/skills/**', '/reports/**'],
  options: {
    typeAware: true,
  },
  jsPlugins: ['oxlint-plugin-eslint'],
  rules: {
    'eslint/logical-assignment-operators': [
      'error',
      'always',
      {
        enforceForIfStatements: true,
      },
    ],
    'eslint-js/no-restricted-syntax': ['error', ...restrictedSyntax],
    // TODO(oxlint): enable in priority order as each backlog is audited.
    // Correctness rules catch async/control-flow bugs; graduate these first.
    'typescript/no-floating-promises': 'off',
    'eslint/no-unsafe-optional-chaining': 'off',
    'typescript/await-thenable': 'off',
    'typescript/no-implied-eval': 'off',
    'unicorn/no-invalid-fetch-options': 'off',
    // Type-safety rules need focused cleanup because current violations are noisy.
    'typescript/restrict-template-expressions': 'off',
    'typescript/no-base-to-string': 'off',
    'typescript/unbound-method': 'off',
    'typescript/no-misused-spread': 'off',
    'typescript/no-this-alias': 'off',
    'typescript/no-duplicate-type-constituents': 'off',
    'typescript/no-meaningless-void-operator': 'off',
    // Lower-risk style/noise rules can follow after correctness and type-safety.
    'typescript/require-array-sort-compare': 'off',
    'typescript/no-redundant-type-constituents': 'off',
    'unicorn/no-new-array': 'off',
    'eslint/no-shadow-restricted-names': 'off',
    'eslint/no-empty-pattern': 'off',
    'unicorn/no-empty-file': 'off',
    'eslint/no-control-regex': 'off',
    'oxc/erasing-op': 'off',
    'typescript/no-useless-default-assignment': 'off',
    'typescript/prefer-as-const': 'off',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        'typescript/no-deprecated': 'error',
      },
    },
    {
      files: ['**/*.test.{ts,tsx,cts,mts,mjs}'],
      rules: {
        'eslint-js/no-restricted-syntax': ['error', ...restrictedSyntax, noRequireInTests],
      },
    },
  ],
});
