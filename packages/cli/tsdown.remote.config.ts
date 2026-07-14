import { createRequire } from 'node:module';
import { defineConfig } from 'tsdown';

const jsoncParserEsmEntry = createRequire(import.meta.url).resolve('jsonc-parser/lib/esm/main.js');

/**
 * Desktop uploads this artifact to macOS and Linux SSH hosts, so it must be a
 * single architecture-neutral JavaScript file with no adjacent chunk graph.
 * Native integrations stay external so the artifact remains portable across
 * CPU architectures; all pure-JS runtime dependencies, including chokidar,
 * are inlined.
 */
export default defineConfig({
  entry: { 'remote-companion': 'src/remote-companion.ts' },
  outDir: 'dist',
  unbundle: false,
  format: 'esm',
  dts: false,
  clean: false,
  minify: true,
  hash: false,
  outputOptions: {
    codeSplitting: false,
    // This banner runs before bundled server modules create their loggers.
    // Stdout stays a frame-only channel; normal diagnostics still go to the
    // remote machine's on-disk log sink.
    banner: "process.env.OK_CONSOLE_LEVEL = 'silent';",
  },
  plugins: [
    {
      name: 'jsonc-parser-esm-entry',
      resolveId(id) {
        return id === 'jsonc-parser' ? jsoncParserEsmEntry : null;
      },
    },
  ],
  deps: {
    neverBundle: [
      '@parcel/watcher',
      '@napi-rs/keyring',
      '@inkeep/open-knowledge-native-config',
      '@mongodb-js/zstd',
      'node-liblzma',
    ],
    alwaysBundle: [/.*/],
  },
});
