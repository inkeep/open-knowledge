import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { listAgentWriteSpineFiles } from './agent-write-spine-files.test-helper.ts';

const here = dirname(fileURLToPath(import.meta.url));

const monorepoRoot = join(here, '..', '..', '..');

const SERVER_PACKAGE_NAME = '@inkeep/open-knowledge-server';

const SPINE_HELPER_SPECIFIER = './agent-write-spine-files.test-helper.ts';

function listWorkspaceManifests(dir: string, depth: number): string[] {
  if (depth === 0) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'package.json') found.push(join(dir, entry.name));
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    found.push(...listWorkspaceManifests(join(dir, entry.name), depth - 1));
  }
  return found;
}

function declaresServerDependency(manifestPath: string): boolean {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ].some((deps) => deps !== undefined && Object.hasOwn(deps, SERVER_PACKAGE_NAME));
}

function listServerConsumerSrcRoots(): string[] {
  return listWorkspaceManifests(monorepoRoot, 4)
    .filter(declaresServerDependency)
    .map((manifestPath) => join(dirname(manifestPath), 'src'))
    .filter((srcRoot) => existsSync(srcRoot))
    .sort();
}

function listCensusFiles(): string[] {
  return readdirSync(here, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('-coverage.test.ts') &&
        readFileSync(join(here, entry.name), 'utf8').includes(SPINE_HELPER_SPECIFIER),
    )
    .map((entry) => entry.name)
    .sort();
}

function spineWalkRootArguments(censusFile: string): string[] {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true, allowJs: false },
  });
  return project
    .addSourceFileAtPath(join(here, censusFile))
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const expr = call.getExpression();
      return Node.isIdentifier(expr) && expr.getText() === 'listAgentWriteSpineFiles';
    })
    .map((call) => call.getArguments()[0]?.getText() ?? '(no argument)');
}

describe('agent-write spine walk root coverage contract', () => {
  it('keeps every applyAgentMarkdownWrite call site inside the walk root both censuses use', () => {
    const consumerSrcRoots = listServerConsumerSrcRoots();
    expect(
      consumerSrcRoots.length,
      `no ${SERVER_PACKAGE_NAME} consumer src roots derived from the workspace manifests`,
    ).toBeGreaterThan(0);
    const outsideCensus = consumerSrcRoots
      .flatMap((srcRoot) =>
        listAgentWriteSpineFiles(srcRoot).map((path) =>
          relative(monorepoRoot, join(srcRoot, path)),
        ),
      )
      .sort();
    expect(outsideCensus).toEqual([]);
  });

  it('holds every spine census to that one walk root', () => {
    const censusFiles = listCensusFiles();
    expect(
      censusFiles.length,
      'no spine census files discovered next to this contract',
    ).toBeGreaterThanOrEqual(1);
    const offRoot = censusFiles
      .flatMap((file) => spineWalkRootArguments(file).map((arg) => `${file}: ${arg}`))
      .filter((entry) => !entry.endsWith(': here'));
    expect(offRoot).toEqual([]);
  });

  it('flags a spine call site planted outside the walk root, and ignores its neighbour', () => {
    const plantedRoot = mkdtempSync(join(tmpdir(), 'ok-agent-write-census-'));
    try {
      writeFileSync(
        join(plantedRoot, 'stray-handler.ts'),
        "applyAgentMarkdownWrite(session.dc.document, 'x', 'append');\n",
      );
      writeFileSync(join(plantedRoot, 'unrelated.ts'), 'export const unrelated = 1;\n');
      expect(listAgentWriteSpineFiles(plantedRoot)).toEqual(['stray-handler.ts']);
    } finally {
      rmSync(plantedRoot, { recursive: true, force: true });
    }
  });
});
