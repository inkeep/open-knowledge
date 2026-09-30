import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, type SourceFile, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { resolveDetachedSpawnArgs } from '../../src/main/resolve-detached-spawn-args.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(HERE, '../..');
const indexTsPath = resolve(desktopRoot, 'src/main/index.ts');

function innermostAppContainer(pathLike: string): string | null {
  const segments = pathLike.split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (
      segments[i]?.endsWith('.app') &&
      segments[i + 1] === 'Contents' &&
      segments[i + 2] === 'MacOS'
    ) {
      return segments.slice(0, i + 1).join('/');
    }
  }
  return null;
}

const spawnProject = new Project({
  useInMemoryFileSystem: true,
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  skipLoadingLibFiles: true,
  compilerOptions: { noLib: true },
});

function unwrapSpawnNode(node: Node | undefined): Node | undefined {
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isExpressionWithTypeArguments(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node)
  )
    node = node.getExpression();
  return node;
}

function spawnCallee(node: Node): boolean {
  return (
    (Node.isIdentifier(node) && node.getText().endsWith('spawn')) ||
    (Node.isPropertyAccessExpression(node) && node.getName().endsWith('spawn'))
  );
}

function processIdentifier(node: Node | undefined): boolean {
  node = unwrapSpawnNode(node);
  return Node.isIdentifier(node) && node.getText() === 'process';
}

function execPathKey(node: Node | undefined): boolean {
  node = unwrapSpawnNode(node);
  if (Node.isComputedPropertyName(node)) return execPathKey(node.getExpression());
  return (
    (Node.isIdentifier(node) && node.getText() === 'execPath') ||
    ((Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) &&
      node.getLiteralValue() === 'execPath')
  );
}

function parentSpawns(file: SourceFile): string[] {
  const assignments = file
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter((node) =>
      [
        SyntaxKind.EqualsToken,
        SyntaxKind.BarBarEqualsToken,
        SyntaxKind.AmpersandAmpersandEqualsToken,
        SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(node.getOperatorToken().getKind()),
    );
  function isParentBinary(node: Node | undefined, seen = new Set<Node>()): boolean {
    node = unwrapSpawnNode(node);
    if (node === undefined || seen.has(node)) return false;
    seen.add(node);
    if (Node.isPropertyAccessExpression(node))
      return processIdentifier(node.getExpression()) && node.getName() === 'execPath';
    if (Node.isElementAccessExpression(node)) {
      const key = unwrapSpawnNode(node.getArgumentExpression());
      return (
        processIdentifier(node.getExpression()) &&
        (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) &&
        key.getLiteralValue() === 'execPath'
      );
    }
    if (Node.isConditionalExpression(node))
      return isParentBinary(node.getWhenTrue(), seen) || isParentBinary(node.getWhenFalse(), seen);
    if (
      Node.isBinaryExpression(node) &&
      [
        SyntaxKind.QuestionQuestionToken,
        SyntaxKind.BarBarToken,
        SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.getOperatorToken().getKind())
    ) {
      return isParentBinary(node.getLeft(), seen) || isParentBinary(node.getRight(), seen);
    }
    if (!Node.isIdentifier(node)) return false;
    const declarations = node.getSymbol()?.getDeclarations() ?? [];
    const bindings = declarations.filter(
      (declaration) =>
        Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration),
    );
    for (const declaration of bindings) {
      if (
        Node.isVariableDeclaration(declaration) &&
        isParentBinary(declaration.getInitializer(), seen)
      )
        return true;
      if (
        Node.isBindingElement(declaration) &&
        !declaration.getDotDotDotToken() &&
        execPathKey(declaration.getPropertyNameNode() ?? declaration.getNameNode())
      ) {
        const pattern = declaration.getParent();
        const variable = pattern.getParent();
        if (
          Node.isObjectBindingPattern(pattern) &&
          Node.isVariableDeclaration(variable) &&
          processIdentifier(variable.getInitializer())
        )
          return true;
      }
    }
    return assignments.some((assignment) => {
      const target = unwrapSpawnNode(assignment.getLeft());
      return (
        Node.isIdentifier(target) &&
        (target.getSymbol()?.getDeclarations() ?? []).some((declaration) =>
          bindings.includes(declaration),
        ) &&
        isParentBinary(assignment.getRight(), seen)
      );
    });
  }
  return file
    .getDescendants()
    .filter((node) => Node.isCallExpression(node) || Node.isNewExpression(node))
    .filter((call) => spawnCallee(call.getExpression()) && isParentBinary(call.getArguments()[0]))
    .map((call) => `parent-binary-spawn: ${call.getText()}`);
}

function directParentSpawns(source: string): string[] {
  const file = spawnProject.createSourceFile('/index.ts', source, { overwrite: true });
  try {
    return parentSpawns(file);
  } finally {
    spawnProject.removeSourceFile(file);
  }
}

function detachedSpawnViolations(source: string): string[] {
  const file = spawnProject.createSourceFile('/index.ts', source, { overwrite: true });
  try {
    const violations = spawnProject
      .getProgram()
      .getSyntacticDiagnostics(file)
      .map((error) => `syntax: ${error.getCode()} at ${error.getStart()}`);
    const resolvers = file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
      const callee = call.getExpression();
      return Node.isIdentifier(callee) && callee.getText() === 'resolveDetachedSpawnArgs';
    });
    if (resolvers.length !== 1) violations.push('detached-resolver call census');
    const call = resolvers[0];
    const binding = call?.getParent();
    if (
      !Node.isVariableDeclaration(binding) ||
      binding.getInitializer() !== call ||
      binding.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const ||
      !Node.isIdentifier(binding.getNameNode())
    ) {
      violations.push('detached-resolver const binding');
    } else {
      const launch = file
        .getDescendants()
        .filter((node) => Node.isCallExpression(node) || Node.isNewExpression(node))
        .some((node) => {
          const first = node.getArguments()[0];
          if (
            !spawnCallee(node.getExpression()) ||
            !Node.isPropertyAccessExpression(first) ||
            first.getName() !== 'file'
          )
            return false;
          const receiver = first.getExpression();
          return (
            Node.isIdentifier(receiver) &&
            (receiver.getSymbol()?.getDeclarations() ?? []).includes(binding)
          );
        });
      if (!launch) violations.push('detached-resolver launch census');
    }
    return [...violations, ...parentSpawns(file)];
  } finally {
    spawnProject.removeSourceFile(file);
  }
}

describe('detached-server spawn: macOS Dock visibility regression guard', () => {
  test.each([
    'spawn(process.execPath)',
    'respawn(process.execPath, args)',
    'cp.respawn(process.execPath, args)',
    'new spawn(process.execPath, args)',
    'new cp.spawn(process.execPath, args)',
    'spawn ( process.execPath, args)',
    'childProcess.spawn(process.execPath, args)',
    'cp.spawn(process.execPath, args)',
    'nested.cp.spawn(process.execPath, args)',
    'const node = process.execPath; spawn(node, args)',
    'const node = process.execPath; cp.spawn(node, args)',
    'const node = process.execPath; const alias = node; spawn(alias, args)',
  ])('detects bypass %s', (source) => {
    expect(directParentSpawns(source)).toHaveLength(1);
  });

  test('allows the resolved binary and locally shadowed safe aliases', () => {
    expect(
      directParentSpawns(`
      spawn(resolved.file, args); cp.spawn(resolved.file, args);
      cp.execFile(process.execPath, args);
      const node = process.execPath;
      function launch() { const node = resolved.file; spawn(node, args); }
      function launchParameter(node) { cp.spawn(node, args); }
      /* spawn(process.execPath, args); */
      const example = 'spawn(process.execPath, args)';
    `),
    ).toEqual([]);
  });

  test.each([
    [
      'let exe; exe = process.execPath; spawn(exe, args)',
      'let exe; exe = resolved.file; spawn(exe, args)',
    ],
    [
      'let exe; exe ||= process.execPath; spawn(exe, args)',
      'let exe; exe ||= resolved.file; spawn(exe, args)',
    ],
    [
      'let exe; exe &&= process.execPath; spawn(exe, args)',
      'let exe; exe &&= resolved.file; spawn(exe, args)',
    ],
    [
      'let exe; exe ??= process.execPath; spawn(exe, args)',
      'let exe; exe ??= resolved.file; spawn(exe, args)',
    ],
    [
      'const { execPath } = process; spawn(execPath, args)',
      'const { execPath } = runtime; spawn(execPath, args)',
    ],
    [
      'const { execPath: exe } = process; spawn(exe, args)',
      'const { execPath: exe } = runtime; spawn(exe, args)',
    ],
    ["spawn(process['execPath'], args)", "spawn(process['other'], args)"],
    ['spawn(process?.execPath, args)', 'spawn(process?.other, args)'],
    ['spawn(process?.[`execPath`], args)', 'spawn(process?.[`other`], args)'],
    [
      'spawn(isDev ? process.execPath : resolved.file, args)',
      'spawn(isDev ? resolved.file : other.file, args)',
    ],
    [
      'spawn(isDev ? resolved.file : process.execPath, args)',
      'spawn(isDev ? resolved.file : other.file, args)',
    ],
    ['spawn((process.execPath as string), args)', 'spawn((resolved.file as string), args)'],
    ['spawn(<string>process.execPath, args)', 'spawn(<string>resolved.file, args)'],
    ['spawn(process.execPath<string>, args)', 'spawn(resolved.file<string>, args)'],
    [
      'spawn((process.execPath satisfies string), args)',
      'spawn((resolved.file satisfies string), args)',
    ],
    ['spawn(process.execPath!, args)', 'spawn(resolved.file!, args)'],
    [
      'let exe = process.execPath; exe = resolved.file; spawn(exe, args)',
      'let exe = other.file; exe = resolved.file; spawn(exe, args)',
    ],
    [
      'let one = two; let two = one; two = process.execPath; spawn(one, args)',
      'let one = two; let two = one; spawn(one, args)',
    ],
    [
      'let exe; function later() { exe = process.execPath; } spawn(exe, args)',
      'let exe; function later() { let exe = process.execPath; } spawn(exe, args)',
    ],
    ['spawn(process.execPath ?? resolved.file, args)', 'spawn(resolved.file ?? other.file, args)'],
    ['spawn(resolved.file ?? process.execPath, args)', 'spawn(resolved.file ?? other.file, args)'],
    ['spawn(process.execPath || resolved.file, args)', 'spawn(resolved.file || other.file, args)'],
    ['spawn(resolved.file || process.execPath, args)', 'spawn(resolved.file || other.file, args)'],
    ['spawn(process.execPath && resolved.file, args)', 'spawn(resolved.file && other.file, args)'],
    ['spawn(resolved.file && process.execPath, args)', 'spawn(resolved.file && other.file, args)'],
  ])('parent-binary pair: %s', (bad, good) => {
    expect(
      directParentSpawns(bad).filter((violation) => violation.startsWith('parent-binary-spawn:')),
    ).toHaveLength(1);
    expect(directParentSpawns(good)).toEqual([]);
  });

  test('bounds parameters and object-held paths outside local binding analysis', () => {
    expect(directParentSpawns('function launchWith(file) { spawn(file, args); }')).toEqual([]);
    expect(
      directParentSpawns(
        'function launchWith(file) { file = process.execPath; spawn(file, args); }',
      ),
    ).toEqual([]);
    expect(directParentSpawns('const o = { exe: process.execPath }; spawn(o.exe, args);')).toEqual(
      [],
    );
  });
  const validLaunchSource =
    'const args = resolveDetachedSpawnArgs({}); spawn(args.file, args.args);';
  test.each([
    ['', 'detached-resolver call census'],
    ['const args = {}; spawn(args.file, args.args);', 'detached-resolver call census'],
    [
      'const args = resolveDetachedSpawnArgs({}); const more = resolveDetachedSpawnArgs({}); spawn(args.file, args.args);',
      'detached-resolver call census',
    ],
    [
      'let args = resolveDetachedSpawnArgs({}); spawn(args.file, args.args);',
      'detached-resolver const binding',
    ],
    ['resolveDetachedSpawnArgs({});', 'detached-resolver const binding'],
    [
      'const args = resolveDetachedSpawnArgs({}); launch(args.file);',
      'detached-resolver launch census',
    ],
    [
      'const args = resolveDetachedSpawnArgs({}); function launch() { const args = {}; spawn(args.file); }',
      'detached-resolver launch census',
    ],
  ])('requires the launch census: %s', (source, violation) => {
    expect(detachedSpawnViolations(validLaunchSource)).toEqual([]);
    expect(detachedSpawnViolations(source).filter((value) => value === violation)).toHaveLength(1);
  });
  test('requires syntactically valid launch source', () => {
    expect(detachedSpawnViolations(validLaunchSource)).toEqual([]);
    expect(
      detachedSpawnViolations(`${validLaunchSource} const broken = ;`).filter((value) =>
        value.startsWith('syntax:'),
      ),
    ).toHaveLength(1);
  });

  test('bypass-pin — index.ts must not call spawn(process.execPath, ...) directly', () => {
    const src = readFileSync(indexTsPath, 'utf-8');
    const match = detachedSpawnViolations(src);
    expect(
      match,
      `\n[dock-visibility] index.ts contains a direct \`spawn(process.execPath, ...)\` ` +
        `call.\n\n` +
        `That is exactly the regression this PR fixed: on packaged macOS, process.execPath ` +
        `is the parent .app's MacOS binary, and spawning it (even under ELECTRON_RUN_AS_NODE=1) ` +
        `triggers LaunchServices to register a duplicate Dock tile (the "exec" placeholder).\n\n` +
        `Route the spawn through resolveDetachedSpawnArgs() — see\n` +
        `  packages/desktop/src/main/resolve-detached-spawn-args.ts\n` +
        `which returns a structurally safe file argument on darwin packaged. The runtime-pin ` +
        `test below covers the resolver's behavior; this bypass-pin covers the spawn site itself.\n\n` +
        `If you intentionally need to spawn the parent binary directly (e.g. for non-detached ` +
        `cases not subject to LaunchServices), document the reason inline and update this test ` +
        `to scope the bypass-pin to the spawnDetachedServer callback specifically.\n`,
    ).toEqual([]);
  });

  test('runtime pin — resolveDetachedSpawnArgs() returns a structurally safe shape on darwin packaged', () => {
    const parentAppPath = '/Applications/OpenKnowledge.app';
    const parentExecPath = `${parentAppPath}/Contents/MacOS/OpenKnowledge`;
    const bundleCliMjsPath = `${parentAppPath}/Contents/Resources/app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/cli.mjs`;
    const reactShellDistDir = `${parentAppPath}/Contents/Resources/app`;

    const result = resolveDetachedSpawnArgs({
      platform: 'darwin',
      isPackaged: true,
      parentExecPath,
      bundleCliMjsPath,
      reactShellDistDir,
      contentDir: '/tmp/some-project',
      spawnErrorLogFd: 5,
      env: { PATH: '/usr/bin' },
    });

    const fileApp = innermostAppContainer(result.file);
    const fileTriggersParentAppLaunch = fileApp === parentAppPath;

    const argv0 = (result.opts as { argv0?: string }).argv0;
    const argv0HasSafeOverride =
      typeof argv0 === 'string' && innermostAppContainer(argv0) !== parentAppPath;

    const ok = !fileTriggersParentAppLaunch || argv0HasSafeOverride;

    expect(
      ok,
      `\n[dock-visibility] resolveDetachedSpawnArgs returned a spawn shape that triggers\n` +
        `LaunchServices on darwin packaged builds:\n` +
        `  file:        ${result.file}\n` +
        `  opts.argv0:  ${argv0 ?? '(unset)'}\n` +
        `  innermost .app of file:   ${fileApp ?? '(none — file is outside any .app)'}\n` +
        `  innermost .app of argv0:  ${typeof argv0 === 'string' ? innermostAppContainer(argv0) : '(no argv0)'}\n\n` +
        `Either the file MUST resolve to a binary outside ${parentAppPath}/Contents/MacOS/\n` +
        `(non-.app Node host or a separate helper .app bundle), or opts.argv0 MUST override\n` +
        `to a path outside the parent .app's MacOS directory.\n`,
    ).toBe(true);
  });
});
