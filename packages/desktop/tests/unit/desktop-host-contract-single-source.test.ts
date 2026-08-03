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

const project = new Project({
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { noLib: true },
});

const contractSources = project.addSourceFilesAtPaths([
  join(packagesRoot, 'core', 'src', '**', '*.{ts,tsx}'),
  join(packagesRoot, 'app', 'src', '**', '*.{ts,tsx}'),
  join(packagesRoot, 'desktop', 'src', '**', '*.{ts,tsx}'),
]);
const coreBridgeSource = project.getSourceFileOrThrow(coreBridge);
const appShimSource = project.addSourceFileAtPath(appShim);
const desktopShimSource = project.addSourceFileAtPath(desktopShim);
const ipcChannelsSource = project.addSourceFileAtPath(ipcChannels);
const coreIndexSource = project.addSourceFileAtPath(join(packagesRoot, 'core', 'src', 'index.ts'));
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
    const bridgeLeafDeclarations = [...coreBridgeSource.getExportedDeclarations()]
      .filter(([, declarations]) =>
        declarations.some((declaration) => declaration.getSourceFile() === coreBridgeSource),
      )
      .map(([typeName]) => typeName);
    const coreBarrelExports = coreIndexSource.getExportedDeclarations();
    expect(bridgeLeafDeclarations.filter((typeName) => coreBarrelExports.has(typeName))).toEqual(
      [],
    );
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
