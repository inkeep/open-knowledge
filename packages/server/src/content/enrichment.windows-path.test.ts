import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withTempDir } from '../../../../test-support/temp-dir.test-helper.ts';
import { enrichDirectory, enrichPath } from './enrichment.ts';

vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, relative: path.win32.relative, sep: path.win32.sep };
});

function writeTemplate(projectDir: string, folder: string, name: string, title: string) {
  const directory = join(projectDir, folder, '.ok', 'templates');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), `---\ntitle: ${title}\n---\n# ${title}\n`);
}

describe('enrichment with win32 relative paths and native filesystem paths', () => {
  test('lists an intermediate ancestor template for a nested directory', async () => {
    await withTempDir('ok-enrichment-path-', async (projectDir) => {
      mkdirSync(join(projectDir, 'Setup', 'Results'), { recursive: true });
      writeTemplate(projectDir, 'Setup', 'setup-categories', 'Setup categories');

      const directory = await enrichDirectory('Setup/Results', { projectDir });

      expect(directory.templates_available).toEqual([
        {
          name: 'setup-categories',
          title: 'Setup categories',
          path: 'Setup/.ok/templates/setup-categories.md',
          source_folder: 'Setup',
          scope: 'inherited',
        },
      ]);
      expect(directory.path).toBe('Setup/Results');
    });
  });

  test('prefers the nearest ancestor while retaining root templates and excluding siblings', async () => {
    await withTempDir('ok-enrichment-precedence-', async (projectDir) => {
      mkdirSync(join(projectDir, 'Setup', 'Results'), { recursive: true });
      writeTemplate(projectDir, '', 'setup-categories', 'Root categories');
      writeTemplate(projectDir, '', 'global', 'Global');
      writeTemplate(projectDir, 'Setup', 'setup-categories', 'Setup categories');
      writeTemplate(projectDir, 'Sibling', 'sibling-only', 'Sibling only');

      const directory = await enrichDirectory('Setup/Results', { projectDir });

      expect(directory.templates_available).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'global', source_folder: '', scope: 'inherited' }),
          expect.objectContaining({
            name: 'setup-categories',
            title: 'Setup categories',
            source_folder: 'Setup',
            scope: 'inherited',
          }),
        ]),
      );
      expect(directory.templates_available).toHaveLength(2);
    });
  });

  test('publishes a slash document identifier without losing its frontmatter', async () => {
    await withTempDir('ok-enrichment-document-', async (projectDir) => {
      mkdirSync(join(projectDir, 'Setup', 'Results'), { recursive: true });
      writeFileSync(
        join(projectDir, 'Setup', 'Results', 'result.md'),
        '---\ntitle: Result\n---\n# Content\n',
      );

      const document = await enrichPath('Setup/Results/result.md', { projectDir });

      expect(document).toMatchObject({
        path: 'Setup/Results/result.md',
        title: 'Result',
        frontmatter: { title: 'Result' },
      });
    });
  });
});
