import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';

const externalizePinoInDts: NonNullable<UserConfig['plugins']> = [
  {
    name: 'externalize-pino-in-dts',
    resolveId(id, importer) {
      if ((id === 'pino' || id.startsWith('pino/')) && importer && /\.d\.[cm]?ts$/.test(importer)) {
        return { id, external: true };
      }
      return null;
    },
  },
];

export default defineConfig({
  // `parse-worker` must stay its own entry: parse-pool.ts spawns it as a
  // worker_threads file next to the importing bundle (`./parse-worker.mjs`
  // sibling probe), so inlining it into index.mjs would leave no file to
  // spawn in dist-based installs.
  entry: { index: 'src/index.ts', 'parse-worker': 'src/parse-worker.ts' },
  unbundle: false,
  format: 'esm',
  dts: { tsconfig: 'tsconfig.build.json' },
  clean: true,
  plugins: externalizePinoInDts,
  deps: {
    neverBundle: ['@parcel/watcher', 'simple-git'],
    // The packaged Electron app installs the server into node_modules and
    // resolves bare specifiers through it. If any future native dep makes
    // electron-builder relocate this package into app.asar.unpacked/ (the
    // same mechanism that bit packages/cli), bare `import 'pino'`
    // would fail because Node's resolver from app.asar.unpacked/ walks the
    // real filesystem only and can't cross into the sibling app.asar/ for
    // node_modules. Inlining the logger deps makes the server's dist
    // self-contained regardless of where electron-builder places it. Scope
    // is intentionally narrow: OTel + Hocuspocus + Tiptap + Yjs stay
    // externalized because their bundling behavior is non-trivial and they
    // are not implicated in the cli bug pattern.
    alwaysBundle: [/^pino(\/|$)/, /^pino-pretty(\/|$)/],
  },
});
