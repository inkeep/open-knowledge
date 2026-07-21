import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'git-repository': 'src/git-repository.ts',
    'shadow-repo-layout': 'src/shadow-repo-layout.ts',
    server: 'src/server.ts',
    keepalive: 'src/keepalive/keepalive.ts',
    'helper-bundle': 'src/helper-bundle.ts',
    'acp-thread-protocol': 'src/acp/thread-protocol.ts',
  },
  unbundle: false,
  format: 'esm',
  dts: false,
  clean: true,
});
