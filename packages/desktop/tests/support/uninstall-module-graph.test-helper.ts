import { fileURLToPath } from 'node:url';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { build, type Plugin } from 'vite';
import { RENDERER_DEDUPE } from '../../../app/vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from '../../../app/vite.react-babel';

/**
 * Builds the `uninstall` renderer entry with the real renderer pipeline (React +
 * React Compiler + the Lingui macro pass) and reports its whole transitive
 * module graph, so a test can prove the entry "connects to nothing" — no editor,
 * CRDT, provider-pool or Hocuspocus-server module is reachable.
 *
 * Why the WHOLE graph and not one output chunk: a forbidden module can be reached
 * indirectly through a shared `@/lib` / `@/components/ui` module, and in a
 * multi-entry build a shared vendor chunk can carry code a named chunk excludes.
 * The entry is therefore built ALONE (its own single-entry build), and the check
 * runs over rollup's loaded-module set (`this.getModuleIds()`) rather than any
 * emitted chunk — so every module here is reachable from this entry by
 * construction, and reachability is read before tree-shaking can hide a
 * side-effecting pull-in.
 */

const APP_ROOT = fileURLToPath(new URL('../../../app/', import.meta.url));
const UNINSTALL_ENTRY = fileURLToPath(
  new URL('../../../app/src/uninstall/main.tsx', import.meta.url),
);

/** Absolute-path marker for modules authored under the uninstall entry's source. */
export const UNINSTALL_SOURCE_DIR = fileURLToPath(
  new URL('../../../app/src/uninstall/', import.meta.url),
);

/**
 * Modules the uninstall entry must never reach. Matched against resolved absolute
 * module ids (pnpm stores third-party packages under `.pnpm/<name>@<ver>/node_modules/<name>/`,
 * so the `node_modules/(.pnpm/…/node_modules/)?` prefix covers both the hoisted
 * and content-addressed shapes). `@inkeep/open-knowledge-core` (shared types +
 * constants, no server deps) is deliberately NOT here — importing it is by design.
 */
export const FORBIDDEN_MODULE_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  // The app's editor bootstrap — the real connectivity risk (provider pool,
  // CRDT observers, doc context). Path-scoped so it covers every editor module.
  { category: 'editor', pattern: /[/\\]packages[/\\]app[/\\]src[/\\]editor[/\\]/ },
  // The Hocuspocus server library — stopped before the survey/completion screens run.
  { category: 'server', pattern: /[/\\]packages[/\\]server[/\\]/ },
  {
    category: 'hocuspocus',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?@hocuspocus[/\\]/,
  },
  // The collaborative CRDT stack (Yjs + its editor bindings). Plain
  // prosemirror/@tiptap markdown-rendering libs are NOT collab and legitimately
  // arrive via core's markdown pipeline, so only the y-* / collaboration bindings
  // are forbidden.
  {
    category: 'crdt',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?yjs[/\\]/,
  },
  {
    category: 'crdt',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?y-protocols[/\\]/,
  },
  {
    category: 'crdt',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?y-prosemirror[/\\]/,
  },
  {
    category: 'crdt',
    pattern:
      /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?y-codemirror\.next[/\\]/,
  },
  {
    category: 'crdt',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?y-indexeddb[/\\]/,
  },
  {
    category: 'crdt',
    pattern:
      /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?@tiptap[/\\]y-tiptap[/\\]/,
  },
  {
    category: 'crdt',
    pattern:
      /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?@tiptap[/\\]extension-collaboration/,
  },
];

/**
 * Module-count ceiling on the entry's loaded graph — a coarse backstop for a
 * heavy, un-enumerated pull-in the name-based denylist can't foresee (e.g. a new
 * barrel dragging in a server-connected subtree). Sits well above today's real
 * count (~2.7k, dominated by `@inkeep/open-knowledge-core`'s single bundled
 * `dist/index.mjs` loaded — though mostly tree-shaken — for a few feedback
 * constants). An editor/CRDT leak pulls hundreds of modules and trips this even
 * if it somehow slipped the denylist; ordinary dep churn does not.
 */
export const MODULE_GRAPH_BUDGET = 3400;

export interface UninstallModuleGraph {
  /** Absolute paths of every on-disk module reachable from the uninstall entry. */
  readonly moduleIds: readonly string[];
  /** Resolved dynamic-import targets whose importer is an uninstall-source module. */
  readonly dynamicImportsFromUninstallSource: readonly string[];
}

/** Every reachable module matching the forbidden denylist, with its category. */
export function findForbiddenModules(
  moduleIds: readonly string[],
): Array<{ category: string; id: string }> {
  const hits: Array<{ category: string; id: string }> = [];
  for (const id of moduleIds) {
    for (const { category, pattern } of FORBIDDEN_MODULE_PATTERNS) {
      if (pattern.test(id)) hits.push({ category, id });
    }
  }
  return hits;
}

const PROBE_ENTRY = 'virtual:ok-uninstall-graph-probe';
const RESOLVED_PROBE_ENTRY = `\0${PROBE_ENTRY}`;

function probeEntryPlugin(entryImports: readonly string[]): Plugin {
  const code = entryImports.map((specifier) => `import ${JSON.stringify(specifier)};`).join('\n');
  return {
    name: 'ok:uninstall-graph-probe',
    resolveId(id) {
      return id === PROBE_ENTRY ? RESOLVED_PROBE_ENTRY : null;
    },
    load(id) {
      return id === RESOLVED_PROBE_ENTRY ? code : null;
    },
  };
}

/** Strip rollup virtual-module (`\0…`) ids and per-import query suffixes. */
function normalizeModuleId(id: string): string | null {
  if (id.startsWith('\0')) return null;
  const path = id.split('?', 1)[0];
  return path.length > 0 ? path : null;
}

/**
 * @param extraEntryImports Additional specifiers to import alongside the real
 *   uninstall entry — used by the planted-positive test to prove the gate fires
 *   when a forbidden module (directly or transitively) enters the graph.
 */
export async function buildUninstallModuleGraph(
  extraEntryImports: readonly string[] = [],
): Promise<UninstallModuleGraph> {
  // The Lingui macro resolves `lingui.config.ts` relative to cwd; this test runs
  // from packages/desktop, so point it at the app's config (same fix as
  // electron.vite.config.ts). Without it the Babel macro pass throws.
  process.env.LINGUI_CONFIG ??= fileURLToPath(
    new URL('../../../app/lingui.config.ts', import.meta.url),
  );

  const moduleIds = new Set<string>();
  const dynamicFromUninstall = new Set<string>();

  const capture: Plugin = {
    name: 'ok:uninstall-graph-capture',
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const normalized = normalizeModuleId(id);
        if (normalized !== null) moduleIds.add(normalized);
        if (!id.includes(`${UNINSTALL_SOURCE_DIR}`)) continue;
        const info = this.getModuleInfo(id);
        for (const dynamicId of info?.dynamicallyImportedIds ?? []) {
          const normalized = normalizeModuleId(dynamicId);
          if (normalized !== null) dynamicFromUninstall.add(normalized);
        }
      }
    },
  };

  await build({
    root: APP_ROOT,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      react(),
      await babel(RENDERER_BABEL_OPTIONS),
      probeEntryPlugin([UNINSTALL_ENTRY, ...extraEntryImports]),
      capture,
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('../../../app/src', import.meta.url)) },
      dedupe: [...RENDERER_DEDUPE],
    },
    build: {
      write: false,
      rolldownOptions: { input: { uninstall: PROBE_ENTRY } },
    },
  });

  return {
    moduleIds: [...moduleIds],
    dynamicImportsFromUninstallSource: [...dynamicFromUninstall],
  };
}
