import { defineConfig } from 'oxlint';

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
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='doMock'] Literal[value='@/components/ui/tooltip'], CallExpression[callee.object.name='vi'][callee.property.name='mock'] Literal[value='@/components/ui/tooltip']",
    message:
      'Do not mock tooltip primitives. Import TooltipProvider and wrap the rendered component instead.',
  },
];

const noRequireInTests = {
  selector: "CallExpression[callee.name='require'], CallExpression[callee.object.name='require']",
  message:
    'require() is not available in an ESM test module. Use a static import or await import(); for a native/CJS addon use createRequire(import.meta.url) bound to a name other than "require" (e.g. require_).',
};

const NO_COMMENTS_PLUGIN = './lint-plugins/no-comments/plugin.mjs';
const OK_RULES_PLUGIN = './lint-plugins/ok-rules/index.mjs';
const NO_COMMENTS_RULE = 'no-comments/no-comments';
const NO_COMMENTS_SEVERITY = 'error';

export default defineConfig({
  ignorePatterns: [
    '.agents/skills/**',
    '.codex/skills/**',
    '/reports/**',
    '/specs/**',
    'lint-plugins/ok-rules/__fixtures__/**',
  ],
  options: {
    typeAware: true,
  },
  jsPlugins: [
    { name: 'eslint-js', specifier: 'oxlint-plugin-eslint' },
    NO_COMMENTS_PLUGIN,
    OK_RULES_PLUGIN,
  ],
  rules: {
    'ok/class-proof-registration-discipline': 'error',
    'ok/cst-pm-handler-todo-stub': 'error',
    'ok/microcopy-ellipsis': 'error',
    'ok/no-blind-agent-host-fanout': 'error',
    'ok/no-demoted-dialog-confirm': 'error',
    'ok/no-hand-rolled-spinner': 'error',
    'ok/no-inline-tolerance-class': 'error',
    'ok/no-loosely-typed-webcontents-ipc': 'error',
    'ok/no-physical-direction-utility': 'error',
    'ok/no-raw-html-interactive-element': 'error',
    'ok/no-raw-route-hash-construction': 'error',
    'ok/no-resolved-value-theme-source': 'error',
    'ok/no-roundtrip-identity-oracle': 'error',
    'ok/no-split-suggestion-dispatch': 'error',
    'ok/no-themeless-pierre-diff': 'error',
    'ok/no-uninstall-forbidden-import': 'error',
    'ok/no-unportaled-editor-content': 'error',
    'ok/no-unwrapped-user-facing-string': 'error',
    'ok/path-conditional-map-driven-origin': 'error',
    'ok/playwright-prefer-to-have-count': 'error',
    'ok/require-utf8-multipart-parser': 'error',
    'ok/require-windowshide-on-spawn': 'error',
    [NO_COMMENTS_RULE]: NO_COMMENTS_SEVERITY,
    'eslint/logical-assignment-operators': [
      'error',
      'always',
      {
        enforceForIfStatements: true,
      },
    ],
    'eslint-js/no-restricted-syntax': ['error', ...restrictedSyntax],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'bun:test',
            message: 'Import test APIs directly from vitest.',
          },
        ],
      },
    ],
    'eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    'typescript/no-floating-promises': 'off',
    'eslint/no-unsafe-optional-chaining': 'off',
    'typescript/await-thenable': 'off',
    'typescript/no-implied-eval': 'off',
    'unicorn/no-invalid-fetch-options': 'off',
    'typescript/restrict-template-expressions': 'off',
    'typescript/no-base-to-string': 'off',
    'typescript/unbound-method': 'off',
    'typescript/no-misused-spread': 'off',
    'typescript/no-this-alias': 'off',
    'typescript/no-duplicate-type-constituents': 'off',
    'typescript/no-meaningless-void-operator': 'off',
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
