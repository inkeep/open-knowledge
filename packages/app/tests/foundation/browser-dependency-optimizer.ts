import { stripVTControlCharacters } from 'node:util';
import type { Logger, Plugin } from 'vite';
import type { Vitest } from 'vitest/node';

export const BROWSER_OPTIMIZE_DEPS_INCLUDE = [
  '@codemirror/legacy-modes/mode/clike',
  '@codemirror/legacy-modes/mode/diff',
  '@codemirror/legacy-modes/mode/gherkin',
  '@codemirror/legacy-modes/mode/lua',
  '@codemirror/legacy-modes/mode/perl',
  '@codemirror/legacy-modes/mode/properties',
  '@codemirror/legacy-modes/mode/r',
  '@codemirror/legacy-modes/mode/ruby',
  '@codemirror/legacy-modes/mode/sql',
  '@codemirror/legacy-modes/mode/swift',
  '@codemirror/legacy-modes/mode/toml',
  '@dnd-kit/core',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@pierre/trees/react',
  '@tiptap/extension-placeholder',
  '@tiptap/pm/history',
  '@tiptap/pm/keymap',
  '@tiptap/react/menus',
  'codemirror',
  'date-fns',
  'frimousse',
  'lucide-react/dist/esm/icons/bot',
  'lucide-react/dist/esm/icons/link-2',
  'lucide-react/dist/esm/icons/package',
  'react-dom/client',
  'react-resizable-panels',
] as const;

const INCLUDE_LIST_LOCATION =
  'BROWSER_OPTIMIZE_DEPS_INCLUDE in packages/app/tests/foundation/browser-dependency-optimizer.ts';
const NEWLY_OPTIMIZED = /new dependenc(?:y|ies) optimized: (.+)$/;
const RELOADING = /optimized dependencies changed\. reloading/;

export function describeDependencyReload(dependencies: readonly string[]): string {
  const named =
    dependencies.length > 0 ? `: ${dependencies.join(', ')}` : ', which the Vite log above names';
  return [
    `The browser tier pre-bundles a fixed dependency list, and this run needed dependencies outside it${named}.`,
    'Vite bundled them mid-run and reloaded the page, which can fail, hang or rerun tests for no product reason.',
    `Add them to ${INCLUDE_LIST_LOCATION}.`,
  ].join('\n');
}

export function dependencyReloadGuard(): Plugin {
  let vitest: Vitest | undefined;
  let discovered: string[] = [];
  const observe = (message: string) => {
    const text = stripVTControlCharacters(message);
    const optimized = NEWLY_OPTIMIZED.exec(text);
    if (optimized?.[1]) {
      for (const name of optimized[1].split(', ')) {
        if (!discovered.includes(name)) discovered.push(name);
      }
    }
    if (!RELOADING.test(text)) return;
    const reload = new Error(describeDependencyReload(discovered));
    discovered = [];
    if (vitest === undefined) throw reload;
    vitest.state.catchError(reload, 'Unhandled Error');
  };
  return {
    name: 'ok:browser-dependency-reload-guard',
    configureVitest(context) {
      vitest = context.vitest;
    },
    configResolved(config) {
      const logger: Logger = config.logger;
      const info = logger.info.bind(logger);
      const warn = logger.warn.bind(logger);
      logger.info = (message, options) => {
        info(message, options);
        observe(message);
      };
      logger.warn = (message, options) => {
        warn(message, options);
        observe(message);
      };
    },
  };
}
