import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Rolldown } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import { PREBUILT_OUTPUT_OPTIONS } from '../../src/build/prebuilt-dev-contract';

const APP: Readonly<Record<string, string>> = {
  'src/selection.ts': "export class NodeSelection {\n  readonly from = 'selection';\n}\n",
  'src/other-selection.ts':
    "export class NodeSelection {\n  readonly from = 'other-selection';\n}\n",
  'src/page-modules.ts':
    "import { NodeSelection as OtherSelection } from './other-selection.ts';\nimport { NodeSelection } from './selection.ts';\n\nexport const selections = [new NodeSelection(), new OtherSelection()];\n",
};

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function app(): string {
  const root = scratch('ok-prebuilt-output-app-');
  for (const [path, content] of Object.entries(APP)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function entryChunk(output: Awaited<ReturnType<typeof build>>): Rolldown.OutputChunk {
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs
    .flatMap((result) => ('output' in result ? result.output : []))
    .find((item) => item.type === 'chunk' && item.isEntry && item.name === 'page-modules');
  if (chunk?.type !== 'chunk') throw new Error('the build wrote no page-modules entry chunk');
  return chunk;
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the prebuilt DEV build output', () => {
  test('classes keep their source names, as the dev server serves them, where bundling and minifying would rename them', async () => {
    const appRoot = app();
    const outDir = join(scratch('ok-prebuilt-output-dist-'), 'dist');

    const chunk = entryChunk(
      await build({
        configFile: false,
        root: appRoot,
        logLevel: 'silent',
        build: {
          outDir,
          emptyOutDir: true,
          rolldownOptions: {
            input: { 'page-modules': join(appRoot, 'src/page-modules.ts') },
            preserveEntrySignatures: 'exports-only',
            output: PREBUILT_OUTPUT_OPTIONS,
          },
        },
      }),
    );
    const { selections } = (await import(pathToFileURL(join(outDir, chunk.fileName)).href)) as {
      selections: readonly object[];
    };

    expect(selections.map((selection) => selection.constructor.name)).toEqual([
      'NodeSelection',
      'NodeSelection',
    ]);
  });
});
