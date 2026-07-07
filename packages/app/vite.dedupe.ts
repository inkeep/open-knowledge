/**
 * Shared `resolve.dedupe` list for the renderer's Vite configs.
 *
 * **Single source of truth** — `packages/app/vite.config.ts` (web/dev path)
 * and `packages/desktop/electron.vite.config.ts` (Electron renderer path)
 * BOTH import from this module. A new y-* / prosemirror-* dependency that
 * needs deduping is added once here; drift between the two configs is
 * structurally impossible.
 *
 * **Why dedupe is load-bearing for this codebase** (full reasoning lives in
 * the consumer files; this is a brief recap so engineers reading just this
 * module understand the stakes):
 *
 *   1. **prosemirror core packages** — Bun's hoisted install can produce
 *      two physical copies (one at `node_modules/<pkg>`, one inside
 *      `.bun/<pkg>@<version>`); Vite's `optimizeDeps` pre-bundle lands
 *      each in its own chunk. `instanceof DecorationSet` checks fail
 *      across chunks; `Selection.jsonID('gapcursor', ...)` registers
 *      twice and throws.
 *
 *   2. **react / react-dom** — TipTap's peer deps pull in a second copy
 *      of React when installed alongside `@tiptap/*`; React requires a
 *      single shared instance for hooks ("Invalid hook call" otherwise).
 *
 *   3. **codemirror packages** — same dual-instance hazard as
 *      prosemirror; the editor's source-mode binding requires single
 *      `@codemirror/state` / `@codemirror/view` to function.
 *
 *   4. **yjs and y-* intermediaries** — yjs's import-guard at
 *      `node_modules/yjs/src/index.js:122-126` detects mixed CJS/ESM
 *      resolution and prints "Yjs was already imported. This breaks
 *      constructor checks…" The latent failure mode is worse than the
 *      warning: `y-prosemirror` and `@tiptap/y-tiptap` each carry their
 *      own `new PluginKey('y-sync')`, so a renderer with both stacks in
 *      the import graph silently breaks `Y.UndoManager.trackedOrigins`
 *      Set-by-identity matching across edit and undo paths. Adding the
 *      y-* intermediaries here (alongside yjs) ensures Vite's
 *      `optimizeDeps` resolves each transitive yjs import to the same
 *      instance regardless of CJS/ESM publication shape on the
 *      intermediary side.
 *
 * **Adding a new entry:** append to the array (alphabetized within the
 * `@-prefix` and bare-name groups). The order doesn't affect Vite's
 * dedupe behavior, but readability + diff legibility benefit from
 * consistency.
 */
export const RENDERER_DEDUPE: readonly string[] = [
  // React core — TipTap peer-deps cause hook-identity dual-instance.
  'react',
  'react-dom',
  // CodeMirror — source-mode binding breaks under dual-instance.
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
  '@codemirror/merge',
  '@codemirror/lang-markdown',
  // Yjs intermediaries (TipTap collaboration + Hocuspocus). Each runs
  // `import * as Y from 'yjs'` at module load with mixed CJS/ESM
  // publication; dedupe forces a single yjs evaluation in the renderer.
  '@hocuspocus/provider',
  '@tiptap/extension-collaboration',
  '@tiptap/extension-collaboration-cursor',
  '@tiptap/y-tiptap',
  // ProseMirror core — every package below requires single-instance
  // resolution to avoid `instanceof` checks failing across chunks.
  'prosemirror-changeset',
  'prosemirror-collab',
  'prosemirror-commands',
  'prosemirror-dropcursor',
  'prosemirror-gapcursor',
  'prosemirror-history',
  'prosemirror-inputrules',
  'prosemirror-keymap',
  'prosemirror-markdown',
  'prosemirror-menu',
  'prosemirror-model',
  'prosemirror-schema-basic',
  'prosemirror-schema-list',
  'prosemirror-state',
  'prosemirror-tables',
  'prosemirror-trailing-node',
  'prosemirror-transform',
  'prosemirror-view',
  // Yjs intermediaries (continued).
  'y-codemirror.next',
  'y-indexeddb',
  'y-prosemirror',
  'y-protocols',
  'yjs',
];
