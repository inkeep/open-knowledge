import { beforeAll, describe, expect, test } from 'vitest';
import {
  buildUninstallModuleGraph,
  findForbiddenModules,
  MODULE_GRAPH_BUDGET,
  type UninstallModuleGraph,
} from '../support/uninstall-module-graph.test-helper';

/**
 * "Connects to nothing" — the PRIMARY gate. The survey and completion screens
 * render after `ok uninstall --yes` has stopped the local Hocuspocus server and
 * removed `~/.ok`, so the uninstall entry's transitive module graph must never
 * reach the editor, the CRDT stack, the provider pool, or the server bootstrap.
 *
 * This asserts over the entry's whole loaded-module set (see the helper), not a
 * single output chunk. The GritQL rule (`no-uninstall-forbidden-import.grit`) is
 * only fast, shallow, first-hop feedback; this graph check is the real gate
 * because it also catches a forbidden module reached indirectly through a shared
 * module.
 */
describe('uninstall entry connects to nothing', () => {
  // Building the real renderer pipeline (React Compiler + Lingui macro) takes a
  // couple of seconds; the planted-positive build pulls the editor + CRDT stack
  // and takes longer.
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
      // The allowed graph legitimately reaches @inkeep/open-knowledge-core (shared
      // types + feedback constants) and, through its markdown pipeline, plain
      // prosemirror / @tiptap rendering libs — none of which connect to anything.
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
      // Lower bound proves the build actually resolved the real tree (not an empty
      // or short-circuited graph that would pass the denylist vacuously).
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
      // Planted positive: import the provider pool, which itself pulls
      // @hocuspocus/provider + yjs. Proves the gate detects both the editor module
      // directly AND the CRDT/server stack it reaches indirectly — the leak shape a
      // first-hop-only check would miss.
      const planted = await buildUninstallModuleGraph(['@/editor/provider-pool']);
      const categories = new Set(findForbiddenModules(planted.moduleIds).map((h) => h.category));

      expect(categories.has('editor')).toBe(true);
      expect(categories.has('crdt') || categories.has('hocuspocus')).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );
});
