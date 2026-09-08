import { defineConfig } from 'tsdown';

const entry = {
  index: 'src/index.ts',
  'git-repository': 'src/git-repository.ts',
  'shadow-repo-layout': 'src/shadow-repo-layout.ts',
  server: 'src/server.ts',
  keepalive: 'src/keepalive/keepalive.ts',
  'helper-bundle': 'src/helper-bundle.ts',
  'skills-catalog': 'src/skills-catalog/index.ts',
  'acp-thread-protocol': 'src/acp/thread-protocol.ts',
  'acp-agent-posture': 'src/acp/agent-posture.ts',
  'acp-permissive-mode': 'src/acp/permissive-mode.ts',
  'acp-codex-legacy-notice': 'src/acp/codex-legacy-notice.ts',
  'desktop-bridge': 'src/desktop-bridge.ts',
};

export default defineConfig([
  {
    entry,
    unbundle: false,
    format: 'esm',
    dts: false,
    clean: true,
  },
  {
    entry,
    unbundle: true,
    format: 'esm',
    dts: { tsconfig: 'tsconfig.build.json', emitDtsOnly: true },
    clean: false,
  },
]);
