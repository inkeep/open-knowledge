import { createRequire } from 'node:module';
import { defineConfig } from 'tsdown';

// jsonc-parser's package `main` is a UMD bundle whose `require('./impl/format')`
// submodule loads are not statically inlinable — bundling it leaves bare
// `./impl/*` requires that crash at runtime from the packaged dist (no
// node_modules beside dist/cli.mjs). Its `module` field is a clean ESM build
// with static relative imports the bundler can follow, so resolve the bare
// `jsonc-parser` specifier straight to that ESM entry before bundling.
const jsoncParserEsmEntry = createRequire(import.meta.url).resolve('jsonc-parser/lib/esm/main.js');

// rolldown-plugin-dts emits this advisory via raw `console.warn` (not through
// rolldown's log pipeline, so `inputOptions.onLog` can't filter it) when tsc
// emit-skips a cross-package source file. The cli's dts entries import from
// `@inkeep/open-knowledge-server` / `-core` whose .ts sources are not in the
// cli's tsconfig include — tsc skips them, the plugin falls back to a
// different emit path, and emits a correct final dist/index.d.mts. The
// recommended fix (`dts.eager`) forces tsc over the full tsconfig graph and
// OOMs node@22 on this monorepo. Suppress the noise; emit correctness is
// verified by the size of dist/index.d.mts (≈106 kB with the expected types).
const dtsEmitFallbackNotice = '[rolldown-plugin-dts] Warning: Failed to emit declaration file';
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith(dtsEmitFallbackNotice)) {
    return;
  }
  originalWarn(...args);
};

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  unbundle: false,
  format: 'esm',
  dts: true,
  clean: true,
  minify: true,
  plugins: [
    {
      name: 'jsonc-parser-esm-entry',
      resolveId(id) {
        return id === 'jsonc-parser' ? jsoncParserEsmEntry : null;
      },
    },
  ],
  inputOptions: (options) => {
    // Filter known false-positive warnings. Each branch documents WHY the
    // warning is suppressed — re-evaluate when bumping rolldown / tsdown /
    // rolldown-plugin-dts. Anything not matched falls through to default.
    options.onLog = (level, log, defaultHandler) => {
      // `@protobufjs/inquire` uses `eval("quire".replace(/^/,"re"))(name)`
      // as a deliberate require-detection workaround for bundlers. The
      // dependency reaches us transitively via @opentelemetry/otlp-transformer
      // (every OTLP exporter). Cannot be patched at source.
      if (
        log.code === 'EVAL' &&
        typeof log.id === 'string' &&
        log.id.includes('/@protobufjs/inquire/')
      ) {
        return;
      }
      // rolldown-plugin-dts strips `type` modifiers from emitted intermediate
      // .d.ts before tracing cross-package re-exports, then warns that the
      // names "are not exported as values". The recommended fix (`dts.eager`)
      // forces tsc over the full tsconfig graph and OOMs node@22 on this
      // monorepo. The names ARE exported as types in source and are correctly
      // bundled into the final dist/index.d.mts.
      if (
        log.code === 'MISSING_EXPORT' &&
        typeof log.id === 'string' &&
        (log.id.endsWith('/src/commands/init.d.ts') || log.id.endsWith('/src/config/schema.d.ts'))
      ) {
        return;
      }
      // Same root cause as MISSING_EXPORT above — the plugin advises
      // enabling `eager` after a fall-back emit; that path OOMs.
      if (
        log.pluginCode === 'rolldown-plugin-dts' &&
        typeof log.message === 'string' &&
        log.message.includes('Failed to emit declaration file')
      ) {
        return;
      }
      defaultHandler(level, log);
    };
    return options;
  },
  deps: {
    // Native addons stay external — they ship .node binaries resolved at runtime
    // and the desktop bundle places them under app.asar.unpacked/node_modules/.
    neverBundle: ['@parcel/watcher', '@napi-rs/keyring', '@inkeep/open-knowledge-native-config'],
    // tsdown defaults to externalizing entries in `dependencies`, but the
    // desktop install ships no node_modules/ next to dist/cli.mjs, so bare
    // specifiers crash on resolve. Force-inline every pure-JS runtime dep.
    // Keep this in sync with packages/cli/package.json `dependencies`.
    alwaysBundle: [
      /^@inquirer\/checkbox(\/|$)/,
      /^@inquirer\/password(\/|$)/,
      /^@inquirer\/select(\/|$)/,
      /^@modelcontextprotocol\/sdk(\/|$)/,
      /^@octokit\/auth-oauth-device(\/|$)/,
      /^@octokit\/request(\/|$)/,
      /^@octokit\/rest(\/|$)/,
      /^@borewit\/text-codec(\/|$)/,
      /^@tokenizer\/inflate(\/|$)/,
      /^@tokenizer\/token(\/|$)/,
      /^cli-boxes(\/|$)/,
      /^commander(\/|$)/,
      /^file-type(\/|$)/,
      /^ieee754(\/|$)/,
      /^jsonc-parser(\/|$)/,
      /^just-bash(\/|$)/,
      /^picocolors(\/|$)/,
      /^picomatch(\/|$)/,
      // pino is used via `pino.destination()` (sync sonic-boom, no worker
      // transports). Externalized, it resolves as a bare specifier from
      // app.asar.unpacked/ at runtime in packaged DMGs and crashes with
      // ERR_MODULE_NOT_FOUND — Node's resolver from app.asar.unpacked/
      // can't cross into the sibling app.asar/ for node_modules. Inlining
      // here removes the runtime resolution entirely.
      /^pino(\/|$)/,
      /^shell-quote(\/|$)/,
      /^simple-git(\/|$)/,
      /^sirv(\/|$)/,
      /^smol-toml(\/|$)/,
      /^strtok3(\/|$)/,
      /^token-types(\/|$)/,
      /^uint8array-extras(\/|$)/,
      /^yaml(\/|$)/,
      /^yazl(\/|$)/,
      /^zod(\/|$)/,
    ],
  },
});
