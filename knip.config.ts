import { existsSync } from 'node:fs';
import type { KnipConfig } from 'knip';

const fidelityOnlyAppDeps = existsSync('packages/app/tests/fidelity')
  ? []
  : ['fast-check', 'commonmark.json', 'remark-mdx', 'remark-parse'];

export default {
  tags: ['-lintignore'],
  ignoreDependencies: [
    'lint-staged', // not sure if it's false positive
    'husky',
    '@lingui/babel-plugin-lingui-macro',
    '@lingui/format-po',
    'micromark',
  ],
  ignoreBinaries: [
    'printf',
    'ps', // process listing — diagnose.ts, process-scan.ts
    'lsof', // open-file listing — diagnose.ts, process-scan.ts
    'pgrep', // process lookup — process-scan.ts
    'where', // Windows binary lookup — git-preflight.ts
    'sw_vers', // macOS version query — bug-report.ts
    'mkfifo', // named-pipe creation — keepalive-orphan-reaping.test.ts
    'xcrun', // macOS notarization tool — desktop afterSign.mjs
    'xdg-mime', // Linux default-app query — desktop ipc-handlers.ts
  ],
  ignoreIssues: {
    'test-support/vitest.base.ts': ['exports'],
    'packages/app/src/locales/**': ['files'],
    'packages/app/src/components/ui/*': ['exports'],
    'docs/src/components/ui/*': ['exports'],
    'docs/source.config.ts': ['exports'],
    'packages/app/src/editor/extensions/internal-link.ts': ['exports', 'types'],
    'packages/app/src/editor/clipboard/serialize.ts': ['types'],
    '{tech-probes,reports,specs}/**': ['files', 'exports', 'types'],
    'tests/integration/**': ['files'],
    'packages/core/src/desktop-bridge.ts': ['files', 'types'],
    'packages/desktop/src/shared/ipc-events.ts': ['files'],
    'packages/app/src/components/CloneDialog.tsx': ['files'],
    'docs/content/**/*.mdx': ['files'],
    'packages/app/src/components/McpConsentDialogBody.tsx': ['duplicates'],
    'packages/core/src/extensions/list.ts': ['duplicates'],
    'packages/desktop/src/main/auto-updater.ts': ['types'],
    'packages/app/src/lib/perf/index.ts': ['exports', 'types'],
    'packages/app/src/lib/perf/env-override.ts': ['types'],
    'packages/app/src/lib/perf/mark.ts': ['types'],
    'packages/app/src/editor/typing-burst-detector.ts': ['exports', 'types'],
    'packages/server/src/bridge-intake.ts': ['types'],
    'packages/core/src/schemas/api.type-tests.ts': ['files'],
    'packages/server/src/http/request-validation.ts': ['exports', 'types'],
    'packages/server/src/http/error-response.ts': ['exports'],
    'packages/app/src/editor/http-client.ts': ['types'],
    '.{agents,codex}/skills/**': ['files'],
    'biome-plugins/__fixtures__/**': ['files'],
    'scripts/compute-next-beta.mjs': ['files'],
    'scripts/assert-smoke-not-vacuous.mjs': ['files'],
    'scripts/assert-app-built.mjs': ['files'],
    'docs/src/lib/share-splash.ts': ['exports', 'types'],
    'packages/app/src/components/PublishToGitHubDialog.tsx': ['types'],
    'packages/app/src/components/ShareButton.tsx': ['types'],
    'packages/app/src/components/ShareReceiveDialog.tsx': ['types'],
    'packages/app/src/lib/share/clone-controller.ts': ['types'],
    'packages/app/src/lib/share/publish-wizard.ts': ['exports', 'types'],
    'packages/app/src/lib/share/receive-flow.ts': ['types'],
    'packages/app/src/lib/share/run-share-action.ts': ['types'],
    'packages/cli/src/commands/share/owners.ts': ['types'],
    'packages/cli/src/commands/share/publish.ts': ['types'],
    'packages/cli/src/commands/init.ts': ['types'],
    'packages/desktop/src/main/create-new-project.ts': ['types'],
    'packages/desktop/src/main/url-scheme.ts': ['types'],
    'packages/desktop/src/shared/bridge-contract.ts': ['types'],
    'packages/desktop/src/shared/ipc-channels.ts': ['types'],
    'packages/app/src/lib/desktop-bridge-types.ts': ['types'],
    'packages/server/src/share/git-context.ts': ['types'],
    'packages/server/src/git-preflight.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health-checks/git.ts': ['exports'],
    'packages/cli/src/commands/diagnose-health-checks/index.ts': ['exports', 'types'],
    'packages/cli/src/commands/diagnose-health-checks/types.ts': ['types'],
    'packages/desktop/src/main/git-preflight-handler.ts': ['types'],
    'packages/native-config/index.js': ['unlisted', 'unresolved'],
  },
  workspaces: {
    'packages/app': {
      entry: [
        'src/**/*.test.{ts,tsx}',
        'tests/**/*.{test,e2e}.ts',
        'tests/perf/lib/*.ts',
        'tests/dom/**/*.ts',
      ],
      project: 'src/**',
      ignoreDependencies: [
        'fuzzysort', // installed for workspace omnibar search ahead of the consumer wire-up
        '@testing-library/jest-dom', // side-effect import (`import '@testing-library/jest-dom'`) registers matchers
        'highlight.js', // lowlight's peer dependency — never imported here directly, but lowlight's grammar registrations resolve through it
        ...fidelityOnlyAppDeps,
      ],
      ignoreFiles: ['src/server/agent-sim.ts'],
    },
    'packages/core': {
      entry: [
        'src/**/*.test.ts',
        'tests/**/*.ts',
        'src/markdown/fixtures/perf/generate.ts',
        'scripts/*.ts',
      ],
      project: 'src/**',
      ignoreDependencies: [
        '@tiptap/y-tiptap',
        'y-prosemirror',
        'mdast-util-mdx-expression',
        'mdast-util-mdx-jsx',
      ],
    },
    docs: {
      entry: ['src/**/*.test.{ts,tsx}'],
    },
    'packages/server': {
      entry: ['src/**/*.test.ts'],
      project: 'src/**',
      ignoreDependencies: [
        '@types/shell-quote',
      ],
    },
    'packages/cli': {
      entry: ['src/**/*.test.ts', 'scripts/*.ts', 'tests/**/*.ts'],
      ignoreDependencies: [
        '@inkeep/open-knowledge-app', // the CLI's `build:assets` script runs `cp -r ../app/dist dist/public`
      ],
    },
    'packages/desktop': {
      entry: ['src/**/*.test.ts', 'scripts/*.mjs', 'tests/**/*.test.ts', 'tests/**/*.test.mjs'],
      ignoreDependencies: ['@inkeep/open-knowledge-native-config', 'culori'],
      project: 'src/**',
    },
  },
} satisfies KnipConfig;
