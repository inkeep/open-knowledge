import { join } from 'node:path';
import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import corePackageJson from '../../../core/package.json';

const packagesRoot = join(__dirname, '..', '..', '..');
const coreBridge = join(packagesRoot, 'core', 'src', 'desktop-bridge.ts');
const appShim = join(packagesRoot, 'app', 'src', 'lib', 'desktop-bridge-types.ts');
const desktopShim = join(packagesRoot, 'desktop', 'src', 'shared', 'bridge-contract.ts');
const ipcChannels = join(packagesRoot, 'desktop', 'src', 'shared', 'ipc-channels.ts');
const coreLeaf = '@inkeep/open-knowledge-core/desktop-bridge';
const ipcTypeAliases = [
  ['OkEditorActiveTargetSnapshot', 'EditorActiveTargetSnapshot'],
  ['OkEditorViewMenuStateSnapshot', 'EditorViewMenuStateSnapshot'],
  ['OkMenuDispatchRole', 'MenuDispatchRole'],
  ['OkMenuDispatchCommand', 'MenuDispatchCommand'],
  ['OkMenuDispatchRequest', 'MenuDispatchRequest'],
  ['OkMenuRendererSnapshot', 'MenuRendererSnapshot'],
] as const;
const ipcTypeReexports = ['OkSharingStatusResult', 'OkSharingSetModeResult'] as const;

const projectOptions = {
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { noLib: true },
} as const;

/**
 * The barrel check below is the only assertion here that pays for a type
 * checker over the real corpus: `getExportedDeclarations()` follows `export *`
 * chains, which the syntactic APIs cannot. (The discrimination test further
 * down builds one too, over a four-file in-memory tree, so its cost does not
 * scale with anything.) Building that checker is by far the most expensive
 * thing this file does, and its cost scales with how many files the project
 * holds rather than with the two this check actually reads.
 *
 * So it gets its own project scoped to `core/src`. That changes how many files
 * the checker takes as program roots, not what it can reach: the compiler host
 * still loads dependencies from disk on demand, so a chain leaving `core/src`
 * resolves either way and this scoped check is no blinder than the shared one.
 * Measured on this tree, each shape in its own process so neither warms the
 * other: 0.64s scoped against 2.74s shared, and 0.23s against 1.18s for the
 * checker alone, with an identical result on both sides.
 *
 * `skipFileDependencyResolution` is not what bounds any of that — it only stops
 * ts-morph eagerly adding a file's imports to the project. That is the whole
 * story in the syntactic-only ts-morph tests elsewhere in the tree, which never
 * build a program at all; it stops being the story here, in the one test that
 * asks for a checker.
 */
const coreProject = new Project(projectOptions);
const coreSources = coreProject.addSourceFilesAtPaths(
  join(packagesRoot, 'core', 'src', '**', '*.{ts,tsx}'),
);
const coreBridgeSource = coreProject.getSourceFileOrThrow(coreBridge);
const coreIndexSource = coreProject.getSourceFileOrThrow(
  join(packagesRoot, 'core', 'src', 'index.ts'),
);

const project = new Project(projectOptions);

// The first test needs core in the syntactic set as well, to prove
// `OkDesktopBridge` is declared nowhere else across the three packages. It only
// ever reads file paths off what it finds, so composing the two projects'
// sources is transparent to it and keeps `core/src` from being parsed twice.
const contractSources = [
  ...coreSources,
  ...project.addSourceFilesAtPaths([
    join(packagesRoot, 'app', 'src', '**', '*.{ts,tsx}'),
    join(packagesRoot, 'desktop', 'src', '**', '*.{ts,tsx}'),
  ]),
];
const appShimSource = project.addSourceFileAtPath(appShim);
const desktopShimSource = project.addSourceFileAtPath(desktopShim);
const ipcChannelsSource = project.addSourceFileAtPath(ipcChannels);
const buildConfigSource = project.addSourceFileAtPath(
  join(packagesRoot, 'core', 'tsdown.config.ts'),
);

function expectTypeOnlyExportStar(sourceFile: SourceFile): void {
  const exportDeclaration = sourceFile
    .getExportDeclarations()
    .find((declaration) => declaration.getModuleSpecifierValue() === coreLeaf);

  expect(exportDeclaration).toBeDefined();
  expect(exportDeclaration?.isTypeOnly()).toBe(true);
  expect(exportDeclaration?.isNamespaceExport()).toBe(true);
  expect(exportDeclaration?.hasNamedExports()).toBe(false);
}

function leafDeclarationNames(bridge: SourceFile): string[] {
  return [...bridge.getExportedDeclarations()]
    .filter(([, declarations]) =>
      declarations.some((declaration) => declaration.getSourceFile() === bridge),
    )
    .map(([typeName]) => typeName);
}

function isWindowGlobalAugmentation(declaration: import('ts-morph').InterfaceDeclaration): boolean {
  return (
    declaration.getName() === 'Window' &&
    declaration.getFirstAncestorByKind(SyntaxKind.ModuleDeclaration)?.getName() === 'global'
  );
}

describe('desktop host contract single source', () => {
  test('keeps the bridge declaration and package leaf in core', () => {
    const bridgeDeclarations = contractSources.flatMap((sourceFile) =>
      sourceFile
        .getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)
        .filter((declaration) => declaration.getName() === 'OkDesktopBridge'),
    );

    expect(
      bridgeDeclarations.map((declaration) => declaration.getSourceFile().getFilePath()),
    ).toEqual([coreBridge]);

    for (const shim of [appShimSource, desktopShimSource]) {
      expectTypeOnlyExportStar(shim);

      const localInterfaces = shim
        .getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)
        .filter((declaration) => !isWindowGlobalAugmentation(declaration));
      expect(localInterfaces).toHaveLength(0);

      for (const alias of shim.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
        expect(Node.isTypeReference(alias.getTypeNodeOrThrow())).toBe(true);
      }
    }

    expect(corePackageJson.exports['./desktop-bridge']).toEqual({
      development: './src/desktop-bridge.ts',
      types: './src/desktop-bridge.ts',
      default: './dist/desktop-bridge.mjs',
    });

    const desktopEntry = buildConfigSource
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .filter((property) => {
        const name = property.getNameNode();
        return Node.isStringLiteral(name) && name.getLiteralText() === 'desktop-bridge';
      });
    expect(desktopEntry).toHaveLength(1);
    expect(desktopEntry[0]?.getInitializerIfKind(SyntaxKind.StringLiteral)?.getLiteralText()).toBe(
      'src/desktop-bridge.ts',
    );
  });

  test('keeps desktop bridge types off the core barrel', () => {
    const bridgeLeafDeclarations = leafDeclarationNames(coreBridgeSource);
    const coreBarrelExports = coreIndexSource.getExportedDeclarations();

    // An empty side would satisfy the intersection below while checking
    // nothing, so a resolution regression could retire this test silently.
    // These floors sit far enough under both counts to catch a collapse
    // without tracking ordinary growth -- deliberately not near them, since
    // both drift with the tree in either direction, and a floor that tracks a
    // moving count becomes maintenance rather than a guard.
    expect(bridgeLeafDeclarations.length).toBeGreaterThan(50);
    expect(coreBarrelExports.size).toBeGreaterThan(500);

    expect(bridgeLeafDeclarations.filter((typeName) => coreBarrelExports.has(typeName))).toEqual(
      [],
    );
  });

  /**
   * The check above reads the real corpus, so it goes green either because
   * nothing leaks or because it stopped being able to see a leak. Only the
   * second is a regression, and the counts it asserts cannot tell them apart.
   *
   * This pins the discrimination directly, on an in-memory tree small enough
   * to state: a mutant that MUST be caught, and a control that MUST stay
   * clean. The mutant routes the leak through an intermediate `export *`,
   * which is reachable only by following the chain, so this fails if
   * `getExportedDeclarations()` ever stops resolving transitively -- the one
   * property that justifies paying for a checker here at all.
   */
  test('the barrel check can still see a leak only a checker would follow', () => {
    const fixture = new Project({ ...projectOptions, useInMemoryFileSystem: true });
    const bridge = fixture.createSourceFile('/bridge.ts', 'export type Leaked = 1;\n');
    fixture.createSourceFile('/relay.ts', "export * from './relay-target.ts';\n");
    fixture.createSourceFile('/relay-target.ts', "export * from './bridge.ts';\n");
    const barrel = fixture.createSourceFile('/index.ts', "export * from './relay.ts';\n");

    const leaked = leafDeclarationNames(bridge).filter((typeName) =>
      barrel.getExportedDeclarations().has(typeName),
    );
    expect(leaked).toEqual(['Leaked']);

    // The control is a NEAR miss rather than a non-miss. Two files sharing no
    // names would pass even if `getExportedDeclarations()` returned nothing at
    // all, which the mutant above already covers. This instead puts a name on
    // BOTH sides that the check must still not flag, because the bridge only
    // passes `Shared` through and does not declare it -- so it exercises the
    // one filter standing between the real check and a false positive.
    const control = new Project({ ...projectOptions, useInMemoryFileSystem: true });
    control.createSourceFile('/origin.ts', 'export type Shared = 1;\n');
    const cleanBridge = control.createSourceFile(
      '/bridge.ts',
      "export type Held = 2;\nexport type { Shared } from './origin.ts';\n",
    );
    const cleanBarrel = control.createSourceFile(
      '/index.ts',
      "export type { Shared } from './origin.ts';\n",
    );
    expect(
      leafDeclarationNames(cleanBridge).filter((typeName) =>
        cleanBarrel.getExportedDeclarations().has(typeName),
      ),
    ).toEqual([]);
  });

  test('keeps IPC payloads as aliases of the core contract', () => {
    const coreImport = ipcChannelsSource
      .getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === coreLeaf);
    expect(coreImport).toBeDefined();
    expect(coreImport?.isTypeOnly()).toBe(true);

    const importedCanonicalTypes = new Map(
      coreImport
        ?.getNamedImports()
        .map((specifier) => [
          specifier.getName(),
          specifier.getAliasNode()?.getText() ?? specifier.getName(),
        ]),
    );

    for (const [canonicalName, localName] of ipcTypeAliases) {
      expect(importedCanonicalTypes.get(canonicalName)).toBe(canonicalName);

      const alias = ipcChannelsSource.getTypeAlias(localName);
      expect(alias).toBeDefined();
      expect(alias?.isExported()).toBe(true);

      const typeNode = alias?.getTypeNode();
      if (!Node.isTypeReference(typeNode)) {
        throw new TypeError(`${localName} must be a type-reference alias`);
      }

      expect(typeNode.getTypeName().getText()).toBe(canonicalName);
      expect(typeNode.getTypeArguments()).toHaveLength(0);
    }

    const directTypeReexports = new Set(
      ipcChannelsSource
        .getExportDeclarations()
        .filter((declaration) => declaration.isTypeOnly() && !declaration.getModuleSpecifier())
        .flatMap((declaration) =>
          declaration.getNamedExports().map((specifier) => specifier.getName()),
        ),
    );

    for (const typeName of ipcTypeReexports) {
      expect(importedCanonicalTypes.get(typeName)).toBe(typeName);
      expect(directTypeReexports.has(typeName)).toBe(true);
    }
  });
});
