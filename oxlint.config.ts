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
    'lint-plugins/no-comments/__fixtures__/**',
    'lint-plugins/ok-rules/__fixtures__/**',
  ],
  options: {
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
  },
  plugins: ['unicorn', 'typescript', 'oxc', 'react', 'jsx-a11y'],
  jsPlugins: [
    { name: 'eslint-js', specifier: 'oxlint-plugin-eslint' },
    NO_COMMENTS_PLUGIN,
    OK_RULES_PLUGIN,
  ],
  rules: {
    'ok/class-proof-registration-discipline': 'error',
    'ok/cst-pm-handler-todo-stub': 'error',
    'ok/microcopy-ellipsis': 'error',
    'ok/no-app-core-barrel-import': 'error',
    'ok/no-blind-agent-host-fanout': 'error',
    'ok/no-blocking-error-box': 'error',
    'ok/no-custom-toast': 'error',
    'ok/no-demoted-dialog-confirm': 'error',
    'ok/no-empty-jsx-expression': 'error',
    'ok/no-fixed-palette-color': 'error',
    'ok/no-hand-rolled-branch-validation': 'error',
    'ok/no-hand-rolled-test-file-suffix': 'error',
    'ok/no-hand-rolled-spinner': 'error',
    'ok/no-inline-tolerance-class': 'error',
    'ok/no-loosely-typed-webcontents-ipc': 'error',
    'ok/no-native-renderer-dialog': 'error',
    'ok/no-physical-direction-utility': 'error',
    'ok/no-raw-error-toast': 'error',
    'ok/no-raw-html-interactive-element': 'error',
    'ok/no-raw-route-hash-construction': 'error',
    'ok/no-redundant-jsx-element-braces': 'error',
    'ok/no-resolved-value-theme-source': 'error',
    'ok/no-roundtrip-identity-oracle': 'error',
    'ok/no-sentinel-signal-target': 'error',
    'ok/no-split-suggestion-dispatch': 'error',
    'ok/no-themeless-pierre-diff': 'error',
    'ok/no-unconverted-git-pathspec': 'error',
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
    'react/jsx-curly-brace-presence': [
      'error',
      { children: 'never', props: 'never', propElementValues: 'ignore' },
    ],
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
    'react/set-state-in-effect': 'off',
    'react-hooks/exhaustive-deps': 'off',
    'react/refs': 'off',
    'react/globals': 'off',
    'react/static-components': 'off',
    'react/immutability': 'off',
    'jsx-a11y/anchor-ambiguous-text': 'error',
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/click-events-have-key-events': 'error',
    'jsx-a11y/no-noninteractive-tabindex': 'error',
    'jsx-a11y/no-static-element-interactions': [
      'error',
      {
        handlers: [
          'onBlur',
          'onClick',
          'onContextMenu',
          'onDblClick',
          'onDoubleClick',
          'onDrag',
          'onDragEnd',
          'onDragEnter',
          'onDragExit',
          'onDragLeave',
          'onDragOver',
          'onDragStart',
          'onDrop',
          'onFocus',
          'onKeyDown',
          'onKeyPress',
          'onKeyUp',
          'onMouseDown',
          'onMouseEnter',
          'onMouseLeave',
          'onMouseMove',
          'onMouseOut',
          'onMouseOver',
          'onMouseUp',
        ],
      },
    ],
    'react/no-danger': 'error',
    'jsx-a11y/prefer-tag-over-role': 'off',
    'jsx-a11y/no-autofocus': 'off',
    'jsx-a11y/no-noninteractive-element-interactions': 'off',
    'jsx-a11y/interactive-supports-focus': 'off',
    'jsx-a11y/media-has-caption': 'off',
    'jsx-a11y/control-has-associated-label': 'off',
    'jsx-a11y/role-has-required-aria-props': 'off',
    'jsx-a11y/heading-has-content': 'off',
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
