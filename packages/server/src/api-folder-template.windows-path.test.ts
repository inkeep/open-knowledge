import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withTempDir } from '../../../test-support/temp-dir.test-helper.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const importedEdges = vi.hoisted<string[]>(() => []);

vi.mock('./mcp/tools/path-safety.ts', async () => {
  const { createRequire, registerHooks } = await import('node:module');
  const safetyUrl = new URL('./mcp/tools/path-safety.ts', import.meta.url).href;
  const replacement = new URL('./win32-relative-path.test-helper.ts', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === safetyUrl && specifier === 'node:path') {
        importedEdges.push(context.parentURL);
        return nextResolve(replacement, context);
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const actual: typeof import('./mcp/tools/path-safety.ts') = createRequire(import.meta.url)(
      './mcp/tools/path-safety.ts',
    );
    return actual;
  } finally {
    hooks.deregister();
  }
});

describe('folder-config HTTP with importer-scoped Node win32 relative paths', () => {
  test('lists the nearest ancestor templates for a slash request while scanning the native target', async () => {
    await withTempDir('ok-folder-config-win32-', async (contentDir) => {
      mkdirSync(resolve(contentDir, 'Setup', 'Results'), { recursive: true });
      writeFileSync(
        resolve(contentDir, 'Setup', 'Results', 'result.md'),
        '---\ntitle: Result\n---\n# Content\n',
      );
      for (const [folder, name, title] of [
        ['', 'setup-categories', 'Root categories'],
        ['', 'global', 'Global'],
        ['Setup', 'setup-categories', 'Setup categories'],
        ['Sibling', 'sibling-only', 'Sibling only'],
      ]) {
        const directory = resolve(contentDir, folder, '.ok', 'templates');
        mkdirSync(directory, { recursive: true });
        writeFileSync(resolve(directory, `${name}.md`), `---\ntitle: ${title}\n---\n# ${title}\n`);
      }

      const server = await bootCompositionRig(contentDir);
      try {
        await server.ready;
        expect(importedEdges).toEqual([
          new URL('./mcp/tools/path-safety.ts', import.meta.url).href,
        ]);
        expect(sep).toBe(process.platform === 'win32' ? '\\' : '/');

        const folder = 'Setup/Results';
        const res = await fetch(
          `http://127.0.0.1:${server.port}/api/folder-config?path=${encodeURIComponent(folder)}`,
        );
        const body: unknown = await res.json();
        expect(res.status).toBe(200);
        expect(body).toMatchObject({
          folder: {
            directMdCount: 1,
            recursiveMdCount: 1,
            childDirCount: 0,
            mostRecentMd: { title: 'Result' },
          },
        });
        expect.soft(body).toHaveProperty('folder.path', folder);
        expect.soft(body).toMatchObject({
          folder: {
            templates_available: expect.arrayContaining([
              {
                name: 'setup-categories',
                title: 'Setup categories',
                path: 'Setup/.ok/templates/setup-categories.md',
                source_folder: 'Setup',
                scope: 'inherited',
              },
              {
                name: 'global',
                title: 'Global',
                path: '.ok/templates/global.md',
                source_folder: '',
                scope: 'inherited',
              },
            ]),
          },
        });
        expect.soft(body).toHaveProperty('folder.templates_available.length', 2);

        const template = await fetch(
          `http://127.0.0.1:${server.port}/api/template?name=setup-categories&folder=${encodeURIComponent(folder)}`,
        );
        const templateBody: unknown = await template.json();
        expect(template.status).toBe(200);
        expect(templateBody).toMatchObject({
          template: {
            folder: 'Setup',
            scope: 'inherited',
            frontmatter: { title: 'Setup categories' },
            body: '# Setup categories\n',
          },
        });
      } finally {
        await server.destroy();
      }
    });
  });
});
