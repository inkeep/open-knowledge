import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CallExpression,
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
} from 'ts-morph';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';

const SERVER_SRC_DIR = import.meta.dir;
const CHILD_PROCESS_MODULE = 'node:child_process';
const CHILD_PROCESS_APIS = new Set(['spawn', 'spawnSync', 'execFile']);
const HIDDEN_HELPERS = new Set(['withHiddenWindowsConsole']);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(abs));
      continue;
    }
    if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-helper.ts')
    ) {
      out.push(abs);
    }
  }
  return out;
}

function childProcessImports(sourceFile: SourceFile): Map<string, string> {
  const imports = new Map<string, string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== CHILD_PROCESS_MODULE) continue;
    for (const namedImport of declaration.getNamedImports()) {
      const importedName = namedImport.getName();
      if (!CHILD_PROCESS_APIS.has(importedName)) continue;
      const localName = namedImport.getAliasNode()?.getText() ?? importedName;
      imports.set(localName, importedName);
    }
  }
  return imports;
}

function promisifiedExecFileBindings(
  sourceFile: SourceFile,
  imports: Map<string, string>,
): Map<string, string> {
  const bindings = new Map<string, string>();
  sourceFile.forEachDescendant((node) => {
    if (!Node.isVariableDeclaration(node)) return;
    const initializer = node.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) return;
    const callee = initializer.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== 'promisify') return;
    const [firstArg] = initializer.getArguments();
    if (!firstArg || !Node.isIdentifier(firstArg)) return;
    if (imports.get(firstArg.getText()) !== 'execFile') return;
    const name = node.getNameNode();
    if (Node.isIdentifier(name)) bindings.set(name.getText(), 'execFile');
  });
  return bindings;
}

function unwrapExpression(node: Node): Node {
  if (
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isParenthesizedExpression(node)
  ) {
    return unwrapExpression(node.getExpression());
  }
  return node;
}

function objectHasWindowsHideTrue(node: ObjectLiteralExpression): boolean {
  return node.getProperties().some((property) => {
    if (!Node.isPropertyAssignment(property)) return false;
    const name = property.getNameNode().getText().replaceAll(/['"]/g, '');
    if (name !== 'windowsHide') return false;
    return property.getInitializer()?.getText() === 'true';
  });
}

function initializerForIdentifier(identifier: Identifier): Node | undefined {
  const symbol = identifier.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  return declaration.getInitializer();
}

function hidesWindowsConsole(node: Node | undefined): boolean {
  if (!node) return false;
  const unwrapped = unwrapExpression(node);
  if (Node.isObjectLiteralExpression(unwrapped)) return objectHasWindowsHideTrue(unwrapped);
  if (Node.isCallExpression(unwrapped)) {
    const callee = unwrapped.getExpression();
    return Node.isIdentifier(callee) && HIDDEN_HELPERS.has(callee.getText());
  }
  if (Node.isIdentifier(unwrapped)) {
    return hidesWindowsConsole(initializerForIdentifier(unwrapped));
  }
  return false;
}

function optionsArgFor(call: CallExpression, api: string): Node | undefined {
  const args = call.getArguments();
  if (api === 'spawn' || api === 'spawnSync') return args[2];
  if (api === 'execFile') return args[2];
  return undefined;
}

describe('Windows child-process console hiding', () => {
  test('option helper forces windowsHide true without mutating the caller options', () => {
    const options = { cwd: '/tmp/project', stdio: 'ignore' as const, windowsHide: false };
    const hidden = withHiddenWindowsConsole(options);

    expect(hidden).toEqual({ cwd: '/tmp/project', stdio: 'ignore', windowsHide: true });
    expect(options.windowsHide).toBe(false);
  });

  test('server child_process call sites hide Windows console windows', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    for (const file of collectSourceFiles(SERVER_SRC_DIR)) {
      project.addSourceFileAtPath(file);
    }

    const violations: string[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const imports = childProcessImports(sourceFile);
      if (imports.size === 0) continue;
      const trackedNames = new Map([
        ...imports,
        ...promisifiedExecFileBindings(sourceFile, imports),
      ]);

      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const callee = node.getExpression();
        if (!Node.isIdentifier(callee)) return;
        const api = trackedNames.get(callee.getText());
        if (!api) return;
        const optionsArg = optionsArgFor(node, api);
        if (hidesWindowsConsole(optionsArg)) return;
        const loc = sourceFile.getLineAndColumnAtPos(node.getStart());
        violations.push(
          `${sourceFile.getFilePath()}:${loc.line}:${loc.column} ${callee.getText()}()`,
        );
      });
    }

    expect(violations).toEqual([]);
  });
});
