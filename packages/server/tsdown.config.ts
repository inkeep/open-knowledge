import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  unbundle: false,
  format: 'esm',
  dts: false,
  clean: true,
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
