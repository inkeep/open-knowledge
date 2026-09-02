import { beforeAll, describe, expect, test } from 'vitest';
import {
  buildUninstallModuleGraph,
  findForbiddenModules,
  MODULE_GRAPH_BUDGET,
  type UninstallModuleGraph,
} from '../support/uninstall-module-graph.test-helper';

describe('uninstall entry connects to nothing', () => {
  const BUILD_TIMEOUT_MS = 120_000;

  describe('the forbidden-module denylist', () => {
    test('flags every editor / CRDT / provider-pool / server category', () => {
      const hits = findForbiddenModules([
        '/repo/packages/app/src/editor/provider-pool.ts',
        '/repo/packages/server/dist/index.mjs',
        '/repo/node_modules/.pnpm/@hocuspocus+provider@3.2.4/node_modules/@hocuspocus/provider/dist/index.js',
        '/repo/node_modules/.pnpm/yjs@13.6.27/node_modules/yjs/dist/yjs.mjs',
        '/repo/node_modules/.pnpm/y-protocols@1.0.6/node_modules/y-protocols/awareness.js',
        '/repo/node_modules/y-prosemirror/dist/y-prosemirror.js',
        '/repo/node_modules/y-indexeddb/dist/y-indexeddb.js',
        '/repo/node_modules/@tiptap/y-tiptap/dist/index.js',
        '/repo/node_modules/@tiptap/extension-collaboration-cursor/dist/index.js',
      ]);
      expect(new Set(hits.map((h) => h.category))).toEqual(
        new Set(['editor', 'server', 'hocuspocus', 'crdt']),
      );
      expect(hits).toHaveLength(9);
    });

    test('does not flag the allowed shared surface (core, shadcn, markdown-render libs)', () => {
      const hits = findForbiddenModules([
        '/repo/packages/app/src/uninstall/UninstallSurveyScreen.tsx',
        '/repo/packages/app/src/components/ui/button.tsx',
        '/repo/packages/app/src/lib/i18n.ts',
        '/repo/packages/core/dist/index.mjs',
        '/repo/node_modules/.pnpm/@tiptap+core@3.6.5/node_modules/@tiptap/core/dist/index.js',
        '/repo/node_modules/.pnpm/prosemirror-view@1.41.4/node_modules/prosemirror-view/dist/index.js',
        '/repo/node_modules/.pnpm/react@19.2.0/node_modules/react/index.js',
      ]);
      expect(hits).toEqual([]);
    });
  });

  describe('the real uninstall entry graph', () => {
    let graph: UninstallModuleGraph;

    beforeAll(async () => {
      graph = await buildUninstallModuleGraph();
    }, BUILD_TIMEOUT_MS);

    test('reaches no forbidden module', () => {
      expect(findForbiddenModules(graph.moduleIds)).toEqual([]);
    });

    test('stays within the module-count budget', () => {
      expect(graph.moduleIds.length).toBeGreaterThan(200);
      expect(graph.moduleIds.length).toBeLessThanOrEqual(MODULE_GRAPH_BUDGET);
    });

    test('uses no dynamic import in its own source (eager-load invariant)', () => {
      expect(graph.dynamicImportsFromUninstallSource).toEqual([]);
    });
  });

  test(
    'the gate fires when an editor module enters the graph',
    async () => {
      const planted = await buildUninstallModuleGraph(['@/editor/provider-pool']);
      const categories = new Set(findForbiddenModules(planted.moduleIds).map((h) => h.category));

      expect(categories.has('editor')).toBe(true);
      expect(categories.has('crdt') || categories.has('hocuspocus')).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );
});
