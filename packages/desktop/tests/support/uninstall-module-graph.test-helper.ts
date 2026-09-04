import { fileURLToPath } from 'node:url';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { build, type Plugin } from 'vite';
import { RENDERER_DEDUPE } from '../../../app/vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from '../../../app/vite.react-babel';

const APP_ROOT = fileURLToPath(new URL('../../../app/', import.meta.url));
const UNINSTALL_ENTRY = fileURLToPath(
  new URL('../../../app/src/uninstall/main.tsx', import.meta.url),
);

export const UNINSTALL_SOURCE_DIR = fileURLToPath(
  new URL('../../../app/src/uninstall/', import.meta.url),
);

export const FORBIDDEN_MODULE_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: 'editor', pattern: /[/\\]packages[/\\]app[/\\]src[/\\]editor[/\\]/ },
  { category: 'server', pattern: /[/\\]packages[/\\]server[/\\]/ },
  {
    category: 'hocuspocus',
    pattern: /[/\\]node_modules[/\\](\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?@hocuspocus[/\\]/,
  },
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

export const MODULE_GRAPH_BUDGET = 3400;

export interface UninstallModuleGraph {
  readonly moduleIds: readonly string[];
  readonly dynamicImportsFromUninstallSource: readonly string[];
}

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

function normalizeModuleId(id: string): string | null {
  if (id.startsWith('\0')) return null;
  const path = id.split('?', 1)[0];
  return path.length > 0 ? path : null;
}

export async function buildUninstallModuleGraph(
  extraEntryImports: readonly string[] = [],
): Promise<UninstallModuleGraph> {
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
