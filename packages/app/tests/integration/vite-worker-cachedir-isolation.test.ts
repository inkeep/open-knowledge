import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import { loadConfigFromFile } from 'vite';
import { describe, expect, test } from 'vitest';

const APP_PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
const APP_VITE_CONFIG = resolve(APP_PACKAGE_ROOT, 'vite.config.ts');
const WORKER_FIXTURES = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/fixtures.ts');

const CACHE_DIR_ENV_VAR = 'OK_TEST_VITE_CACHE_DIR';

function readWorkerCacheGraph(entry: string): Record<string, string> {
  const modules: Record<string, string> = {};
  const visit = (path: string) => {
    if (path in modules) return;
    const source = readFileSync(path, 'utf8');
    modules[path] = source;
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true },
    });
    const file = project.createSourceFile(path, source);
    for (const declaration of file.getImportDeclarations()) {
      const module = declaration.getModuleSpecifierValue();
      if (module.startsWith('.')) visit(resolve(file.getDirectoryPath(), module));
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const first = call.getArguments()[0];
      if (
        call.getExpression().getText() === 'require' &&
        Node.isStringLiteral(first) &&
        first.getLiteralValue().startsWith('.')
      )
        visit(resolve(file.getDirectoryPath(), first.getLiteralValue()));
      if (call.getExpression().getText() !== 'join' || first?.getText() !== 'import.meta.dirname')
        continue;
      const parts = call.getArguments().slice(1);
      if (
        parts.length === 1 &&
        Node.isStringLiteral(parts[0]) &&
        parts[0].getLiteralValue().endsWith('.cjs')
      )
        visit(resolve(file.getDirectoryPath(), parts[0].getLiteralValue()));
    }
  };
  visit(entry);
  return modules;
}

function inspectWorkerCache(
  source: string,
  modules: Readonly<Record<string, string>> = {},
  entry = '/fixtures.ts',
) {
  type Path = 'failure' | 'normal' | 'acquisition';
  type FunctionNode =
    | import('ts-morph').FunctionDeclaration
    | import('ts-morph').ArrowFunction
    | import('ts-morph').FunctionExpression;
  type Frame = {
    scope: Node;
    parent?: Frame;
    key: string;
    path: Path;
    bindings: Map<Node, Value>;
    assignments: Map<import('ts-morph').Symbol, Value>;
  };
  type Value = { node: Node; frame: Frame };
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      noLib: true,
      allowJs: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  for (const [path, text] of Object.entries(modules)) {
    if (path !== entry) project.createSourceFile(path, text);
  }
  const syntax = project.createSourceFile(`${entry}.syntax.ts`, source);
  const input = project.createSourceFile(
    entry,
    ts.transpile(source, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    }),
  );
  const exported = input.getExportedDeclarations().get('test')?.filter(Node.isVariableDeclaration);
  const file = exported?.length === 1 ? exported[0].getSourceFile() : input;
  const functions = (node: Node): node is FunctionNode =>
    Node.isFunctionDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node);
  const nodeKey = (node: Node) =>
    `${node.getSourceFile().getFilePath()}:${node.getStart()}:${node.getKind()}`;
  const key = (value: Value) => `${nodeKey(value.node)}@${value.frame.key}`;
  const ownFunction = (node: Node) =>
    node.getFirstAncestor((ancestor) => ts.isFunctionLike(ancestor.compilerNode));
  const frames = new Map<import('ts-morph').SourceFile, Frame>();
  const frame = (scope: Node, parent: Frame | undefined, identity: string, path: Path): Frame => {
    const result: Frame = {
      scope,
      parent,
      key: identity,
      path,
      bindings: new Map(),
      assignments: new Map(),
    };
    for (const assignment of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (
        ownFunction(assignment) !== (functions(scope) ? scope : undefined) ||
        assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
      )
        continue;
      const symbol = assignment.getLeft().getSymbol();
      if (symbol) result.assignments.set(symbol, { node: assignment.getRight(), frame: result });
    }
    return result;
  };
  const moduleFrame = (module: import('ts-morph').SourceFile): Frame => {
    let result = frames.get(module);
    if (!result) {
      result = frame(module, undefined, module.getFilePath(), 'acquisition');
      frames.set(module, result);
    }
    return result;
  };
  const lexical = (node: Node, context: Frame): Frame => {
    const owner = ownFunction(node);
    for (let current: Frame | undefined = context; current; current = current.parent) {
      if (
        owner
          ? current.scope === owner
          : Node.isSourceFile(current.scope) && current.scope === node.getSourceFile()
      )
        return current;
    }
    return moduleFrame(node.getSourceFile());
  };
  const imported = (node: Node): { module: string; name: string } | undefined => {
    const declaration = node.getSymbol()?.getDeclarations()[0];
    if (Node.isImportSpecifier(declaration))
      return {
        module: declaration.getImportDeclaration().getModuleSpecifierValue(),
        name: declaration.getName(),
      };
    if (Node.isBindingElement(declaration)) {
      const owner = declaration.getParent().getParent();
      const call = Node.isVariableDeclaration(owner)
        ? owner.getInitializerIfKind(SyntaxKind.CallExpression)
        : undefined;
      const path = call?.getArguments()[0];
      if (call?.getExpression().getText() === 'require' && Node.isStringLiteral(path))
        return {
          module: path.getLiteralValue(),
          name: declaration.getPropertyNameNode()?.getText() ?? declaration.getName(),
        };
    }
    return undefined;
  };
  const localModule = (from: Node, path: string) =>
    project.getSourceFile(resolve(from.getSourceFile().getDirectoryPath(), path));
  const failures = new Set<string>();
  const unwrap = (value: Value): Value => {
    let node = value.node;
    while (
      Node.isParenthesizedExpression(node) ||
      Node.isAwaitExpression(node) ||
      Node.isAsExpression(node) ||
      Node.isSatisfiesExpression(node) ||
      Node.isNonNullExpression(node)
    )
      node = node.getExpression();
    return { ...value, node };
  };
  const fn = (value: Value): { node: FunctionNode; closure: Frame } | undefined => {
    const current = unwrap(value);
    if (functions(current.node)) return { node: current.node, closure: current.frame };
    const binding = imported(current.node);
    if (binding?.module.startsWith('.')) {
      const target = localModule(current.node, binding.module);
      const declaration =
        target?.getExportedDeclarations().get(binding.name)?.find(functions) ??
        target?.getFunction(binding.name);
      if (declaration && functions(declaration))
        return { node: declaration, closure: moduleFrame(declaration.getSourceFile()) };
    }
    const declaration = current.node.getSymbol()?.getDeclarations()[0];
    if (functions(declaration))
      return { node: declaration, closure: lexical(declaration, current.frame) };
    return undefined;
  };
  const boundFunction = (
    call: import('ts-morph').CallExpression,
    context: Frame,
    target: { node: FunctionNode; closure: Frame },
  ): Frame => {
    const result = frame(
      target.node,
      target.closure,
      `${context.key}/${nodeKey(call)}`,
      context.path,
    );
    for (const [index, parameter] of target.node.getParameters().entries()) {
      const argument = call.getArguments()[index];
      if (argument) result.bindings.set(parameter, { node: argument, frame: context });
      else {
        const initializer = parameter.getInitializer();
        if (initializer) result.bindings.set(parameter, { node: initializer, frame: result });
      }
    }
    return result;
  };
  const value = (input: Value | undefined, seen = new Set<string>()): Value | undefined => {
    if (!input) return undefined;
    const current = unwrap(input);
    const identity = key(current);
    if (seen.has(identity)) return undefined;
    const next = new Set(seen).add(identity);
    const node = current.node;
    if (Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node)) {
      const context = lexical(node, current.frame);
      const bound = context.bindings.get(node);
      if (bound) return value(bound, next);
      const initializer = node.getInitializer();
      const symbol = node.getSymbol();
      const assigned = symbol && context.assignments.get(symbol);
      return initializer
        ? value({ node: initializer, frame: context }, next)
        : assigned
          ? value(assigned, next)
          : { node, frame: context };
    }
    if (Node.isIdentifier(node)) {
      const declaration = node.getSymbol()?.getDeclarations()[0];
      return declaration &&
        (Node.isVariableDeclaration(declaration) ||
          Node.isParameterDeclaration(declaration) ||
          Node.isBindingElement(declaration))
        ? value({ node: declaration, frame: current.frame }, next)
        : current;
    }
    if (Node.isPropertyAssignment(node))
      return value({ node: node.getInitializerOrThrow(), frame: current.frame }, next);
    if (Node.isShorthandPropertyAssignment(node)) {
      const declaration = node.getValueSymbol()?.getDeclarations()[0];
      return declaration ? value({ node: declaration, frame: current.frame }, next) : undefined;
    }
    if (Node.isBindingElement(node)) {
      const owner = node.getParent().getParent();
      const object =
        Node.isVariableDeclaration(owner) || Node.isParameterDeclaration(owner)
          ? value({ node: owner, frame: current.frame }, next)
          : undefined;
      return (
        property(object, node.getPropertyNameNode()?.getText() ?? node.getName(), next) ?? current
      );
    }
    if (Node.isPropertyAccessExpression(node))
      return (
        property(
          value({ node: node.getExpression(), frame: current.frame }, next),
          node.getName(),
          next,
        ) ?? current
      );
    if (Node.isCallExpression(node)) {
      const target = fn(
        value({ node: node.getExpression(), frame: current.frame }, next) ?? {
          node: node.getExpression(),
          frame: current.frame,
        },
      );
      if (target) {
        const called = boundFunction(node, current.frame, target);
        const body = target.node.getBody();
        const returns = body
          ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
          .filter((statement) => ownFunction(statement) === target.node);
        const returned = Node.isBlock(body)
          ? returns?.length === 1
            ? returns[0].getExpression()
            : undefined
          : body;
        if (returned) return value({ node: returned, frame: called }, next);
      }
    }
    return current;
  };
  const property = (
    input: Value | undefined,
    name: string,
    seen = new Set<string>(),
  ): Value | undefined => {
    const object = input && value(input, seen);
    if (!object || !Node.isObjectLiteralExpression(object.node)) return undefined;
    const field = object.node
      .getProperties()
      .find(
        (field) =>
          (Node.isPropertyAssignment(field) || Node.isShorthandPropertyAssignment(field)) &&
          field.getName() === name,
      );
    return field ? value({ node: field, frame: object.frame }, seen) : undefined;
  };
  const primitive = (input: Value | undefined): string | number | boolean | undefined => {
    const current = input && value(input);
    if (current && Node.isStringLiteral(current.node)) return current.node.getLiteralValue();
    if (current && Node.isNumericLiteral(current.node)) return current.node.getLiteralValue();
    if (current?.node.getKind() === SyntaxKind.TrueKeyword) return true;
    if (current?.node.getKind() === SyntaxKind.FalseKeyword) return false;
    return undefined;
  };
  const condition = (node: Node, context: Frame): boolean | undefined => {
    if (
      Node.isBinaryExpression(node) &&
      [SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.getOperatorToken().getKind(),
      )
    ) {
      const left = primitive({ node: node.getLeft(), frame: context });
      const right = primitive({ node: node.getRight(), frame: context });
      if (left !== undefined && right !== undefined)
        return node.getOperatorToken().getKind() === SyntaxKind.EqualsEqualsEqualsToken
          ? left === right
          : left !== right;
    }
    const result = primitive({ node, frame: context });
    return typeof result === 'boolean' ? result : undefined;
  };
  const callsOf = (scope: Node, context: Frame) =>
    scope.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
      if (ownFunction(call) !== (functions(scope) ? scope : undefined)) return false;
      for (const ancestor of call.getAncestors()) {
        if (ancestor === scope) break;
        if (!Node.isIfStatement(ancestor)) continue;
        const choice = condition(ancestor.getExpression(), context);
        if (choice === undefined) continue;
        const selected = choice ? ancestor.getThenStatement() : ancestor.getElseStatement();
        if (!selected || call.getStart() < selected.getStart() || call.getEnd() > selected.getEnd())
          return false;
      }
      return true;
    });
  const declaration = file.getVariableDeclaration('test');
  const extend = declaration?.getInitializerIfKind(SyntaxKind.CallExpression);
  const callee = extend?.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  const registrationFrame = moduleFrame(file);
  const workerProperty = property(
    extend?.getArguments()[0]
      ? { node: extend.getArguments()[0], frame: registrationFrame }
      : undefined,
    'workerServer',
  );
  const fixture = workerProperty?.node
    .asKind(SyntaxKind.ArrayLiteralExpression)
    ?.getElements()[0]
    ?.asKind(SyntaxKind.ArrowFunction);
  const worker = fixture?.getParameters()[2];
  const workerFrame = fixture ? frame(fixture, registrationFrame, 'worker', 'normal') : undefined;
  const spawns: Array<{ call: import('ts-morph').CallExpression; frame: Frame }> = [];
  const reclaims: Array<{ path: Path; resources: Value[] }> = [];
  const arrays = new Map<string, Value[]>();
  const owners = new Map<string, { frame: Frame; handler: Value }>();
  const reached = new Set<string>();
  const active = new Set<Node>();
  const callbacks = (argument: Node, context: Frame): Value[] => {
    if (Node.isSpreadElement(argument)) return callbacks(argument.getExpression(), context);
    const current = value({ node: argument, frame: context });
    if (!current) return [];
    if (Node.isCallExpression(current.node)) {
      const expression = current.node.getExpression();
      if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'reverse')
        return callbacks(expression.getExpression(), current.frame).reverse();
    }
    if (Node.isArrayLiteralExpression(current.node)) {
      const registered = arrays.get(key(current));
      return registered
        ? registered
        : current.node.getElements().flatMap((item) => callbacks(item, current.frame));
    }
    return [current];
  };
  const nativeName = (node: Node, module: string, name: string) => {
    const binding = imported(node);
    return (
      binding?.name === name &&
      (binding.module === module || binding.module === module.replace('node:', ''))
    );
  };
  const entryFor = (call: import('ts-morph').CallExpression): string | undefined => {
    const args = call.getArguments()[1]?.asKind(SyntaxKind.ArrayLiteralExpression)?.getElements();
    const script = args?.[0]?.asKind(SyntaxKind.CallExpression);
    if (!script || !nativeName(script.getExpression(), 'node:path', 'join')) return undefined;
    const parts = script.getArguments();
    if (
      parts[0]?.getText() !== 'import.meta.dirname' ||
      !parts.slice(1).every(Node.isStringLiteral)
    )
      return undefined;
    return resolve(
      call.getSourceFile().getDirectoryPath(),
      ...parts.slice(1).map((part) => (part as import('ts-morph').StringLiteral).getLiteralValue()),
    );
  };
  const invoke = (
    target: { node: FunctionNode; closure: Frame },
    call: import('ts-morph').CallExpression,
    context: Frame,
  ) => {
    if (active.has(target.node)) return;
    active.add(target.node);
    walk(target.node, boundFunction(call, context, target));
    active.delete(target.node);
  };
  const walk = (scope: Node, context: Frame): void => {
    for (const call of callsOf(scope, context)) {
      const expression = call.getExpression();
      const callContext = {
        ...context,
        path: call.getFirstAncestorByKind(SyntaxKind.CatchClause)
          ? ('failure' as const)
          : context.path,
      };
      const current = value({ node: expression, frame: context }) ?? {
        node: expression,
        frame: context,
      };
      const binding = imported(current.node);
      if (nativeName(current.node, 'node:child_process', 'spawn')) {
        if (call.getArguments()[0]?.getText() !== 'process.execPath') {
          spawns.push({ call, frame: context });
          continue;
        }
        const entryPath = entryFor(call);
        const owner = entryPath && project.getSourceFile(entryPath);
        const args = call
          .getArguments()[1]
          ?.asKind(SyntaxKind.ArrayLiteralExpression)
          ?.getElements();
        const encoded = args?.[1]?.asKind(SyntaxKind.CallExpression);
        const payload =
          encoded?.getExpression().getText() === 'JSON.stringify' && encoded.getArguments()[0]
            ? value({ node: encoded.getArguments()[0], frame: context })
            : undefined;
        const decoders = owner
          ?.getVariableDeclarations()
          .filter(
            (variable) => variable.getInitializer()?.getText() === 'JSON.parse(process.argv[2])',
          );
        const handlers = owner
          ?.getDescendantsOfKind(SyntaxKind.CallExpression)
          .filter(
            (candidate) =>
              candidate.getExpression().getText() === 'process.on' &&
              candidate.getArguments()[0]?.getText() === "'message'",
          );
        if (
          !owner ||
          !payload ||
          !Node.isObjectLiteralExpression(payload.node) ||
          decoders?.length !== 1 ||
          handlers?.length !== 1 ||
          !Node.isArrowFunction(handlers[0].getArguments()[1])
        ) {
          failures.add(`process-entry:${entryPath ?? nodeKey(call)}`);
          continue;
        }
        const owned = frame(owner, context, `${context.key}/${nodeKey(call)}/entry`, 'acquisition');
        owned.bindings.set(decoders[0], payload);
        owners.set(key({ node: call, frame: context }), {
          frame: owned,
          handler: { node: handlers[0].getArguments()[1], frame: owned },
        });
        walk(owner, owned);
        continue;
      }
      const removal =
        nativeName(current.node, 'node:fs', 'rmSync') ||
        (binding?.name === 'removeAllDuringTeardown' && binding.module.endsWith('/teardown-fs.ts'));
      if (removal) {
        reclaims.push({
          path: callContext.path,
          resources: call
            .getArguments()
            .map((arg) => value({ node: arg, frame: context }))
            .filter((item): item is Value => item !== undefined),
        });
        continue;
      }
      if (binding?.name === 'runTeardownPhases' && binding.module.endsWith('/teardown-fs.ts')) {
        for (const argument of call.getArguments())
          for (const callback of callbacks(argument, context)) {
            const target = fn(callback);
            if (target) invoke(target, call, callContext);
            else failures.add(`release-binding:${nodeKey(call)}`);
          }
        continue;
      }
      if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'push') {
        const receiver = value({ node: expression.getExpression(), frame: context });
        if (receiver && Node.isArrayLiteralExpression(receiver.node)) {
          const additions = call
            .getArguments()
            .map((node) => ({ node, frame: context }))
            .filter((item) => fn(item));
          arrays.set(key(receiver), [...(arrays.get(key(receiver)) ?? []), ...additions]);
        }
      }
      if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'send') {
        const receiver = value({ node: expression.getExpression(), frame: context });
        const owned = receiver && owners.get(key(receiver));
        if (owned) {
          const target = fn(owned.handler);
          if (target) invoke(target, call, callContext);
          else failures.add(`control-binding:${nodeKey(call)}`);
        }
      }
      const target = fn(current);
      if (target) invoke(target, call, callContext);
    }
  };
  if (fixture && workerFrame) walk(fixture, workerFrame);
  const baseBinding = callee && imported(callee.getExpression());
  const census = Object.entries({
    syntax: project
      .getSourceFiles()
      .every((sourceFile) => project.getProgram().getSyntacticDiagnostics(sourceFile).length === 0),
    test: !!declaration?.getVariableStatement()?.isExported(),
    extend:
      callee?.getName() === 'extend' &&
      baseBinding?.module === '@playwright/test' &&
      baseBinding.name === 'test',
    workerServer: !!fixture,
    workerInfo: !!worker,
    spawn: spawns.length > 0,
  }).flatMap(([name, holds]) => (holds ? [] : [name]));
  census.push(...failures);
  const unique = (input: Value | undefined): boolean => {
    const current = input && value(input);
    if (!current) return false;
    if (
      Node.isCallExpression(current.node) &&
      nativeName(current.node.getExpression(), 'node:fs', 'mkdtempSync')
    )
      return true;
    for (const part of [current.node, ...current.node.getDescendants()]) {
      if (Node.isPropertyAccessExpression(part) && part.getName() === 'workerIndex') {
        const object = value({ node: part.getExpression(), frame: current.frame });
        if (object?.node === worker) return true;
      }
    }
    return false;
  };
  let missingEnv = 0,
    nonUnique = 0,
    missingCleanup = 0,
    teardowns = 0;
  for (const { call, frame: context } of spawns) {
    const options = call.getArguments()[2];
    const env = property(options ? { node: options, frame: context } : undefined, 'env');
    const cache = property(env, CACHE_DIR_ENV_VAR);
    const object = env && value(env);
    const field =
      object && Node.isObjectLiteralExpression(object.node)
        ? object.node
            .getProperties()
            .find(
              (field) =>
                (Node.isPropertyAssignment(field) || Node.isShorthandPropertyAssignment(field)) &&
                field.getName() === CACHE_DIR_ENV_VAR,
            )
        : undefined;
    if (field) reached.add(nodeKey(field));
    if (!cache) {
      missingEnv++;
      continue;
    }
    if (!unique(cache)) nonUnique++;
    const content = property(env, 'OK_TEST_CONTENT_DIR');
    for (const path of ['failure', 'normal'] as const) {
      const removals = reclaims
        .filter((reclaim) => reclaim.path === path)
        .flatMap((reclaim) => reclaim.resources.map(key));
      const hasContent = !!content && removals.includes(key(content));
      const hasCache = removals.includes(key(cache));
      teardowns += Number(hasContent);
      missingCleanup += Number(!hasContent || !hasCache);
    }
  }
  for (const subject of project.getSourceFiles().filter((subject) => subject !== syntax)) {
    for (const field of subject
      .getDescendants()
      .filter(
        (node) =>
          (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) &&
          node.getName() === CACHE_DIR_ENV_VAR,
      )) {
      if (reached.has(nodeKey(field))) continue;
      if (
        !unique({
          node: field,
          frame: subject === file ? (workerFrame ?? registrationFrame) : moduleFrame(subject),
        })
      )
        nonUnique++;
    }
    if (spawns.length > 0) {
      const accounted = new Set(spawns.map((spawn) => nodeKey(spawn.call)));
      for (const owner of owners.keys()) accounted.add(owner.split('@')[0]);
      for (const call of subject.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (
          nativeName(call.getExpression(), 'node:child_process', 'spawn') &&
          !accounted.has(nodeKey(call))
        )
          census.push(`unreached-spawn:${nodeKey(call)}`);
      }
    }
  }
  return { census, missingEnv, nonUnique, missingCleanup, spawns: spawns.length, teardowns };
}

async function withEnv<T>(
  key: string,
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await body();
  } finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

describe('per-worker Vite cacheDir isolation — vite.config.ts side', () => {
  test('A1: resolves cacheDir from OK_TEST_VITE_CACHE_DIR env var', async () => {
    const expected = '/tmp/ok-vite-cachedir-isolation-test-a1';
    await withEnv(CACHE_DIR_ENV_VAR, expected, async () => {
      const result = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      expect(result?.config.cacheDir).toBe(expected);
    });
  });

  test('A2: distinct OK_TEST_VITE_CACHE_DIR values produce distinct resolved cacheDirs (anti-vacuousness)', async () => {
    const pathW0 = '/tmp/ok-vite-cachedir-isolation-test-a2-w0';
    const pathW1 = '/tmp/ok-vite-cachedir-isolation-test-a2-w1';
    const cacheW0 = await withEnv(CACHE_DIR_ENV_VAR, pathW0, async () => {
      const r = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      return r?.config.cacheDir;
    });
    const cacheW1 = await withEnv(CACHE_DIR_ENV_VAR, pathW1, async () => {
      const r = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      return r?.config.cacheDir;
    });
    expect(cacheW0).toBe(pathW0);
    expect(cacheW1).toBe(pathW1);
    expect(cacheW0).not.toBe(cacheW1);
  });
});

describe('per-worker Vite cacheDir isolation — workerServer fixture side', () => {
  const inspect = () => {
    const graph = readWorkerCacheGraph(WORKER_FIXTURES);
    return inspectWorkerCache(graph[WORKER_FIXTURES], graph, WORKER_FIXTURES);
  };
  test(`B1: workerServer spawn() env declares ${CACHE_DIR_ENV_VAR}`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(
      result.missingEnv,
      `Declare ${CACHE_DIR_ENV_VAR} on the workerServer fixture's spawn env. Otherwise workers share Vite's default node_modules/.vite cache, whose optimizer is single-writer. See PR #1146 AC-T3 / F1.`,
    ).toBe(0);
  });
  test(`B2: ${CACHE_DIR_ENV_VAR} value is per-worker unique (references workerInfo.workerIndex or mkdtempSync)`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(result.missingEnv).toBe(0);
    expect(
      result.nonUnique,
      `${CACHE_DIR_ENV_VAR} must be, or be bound through variables to, an expression that itself calls the imported mkdtempSync or reads the fixture's workerInfo.workerIndex. A static string does not isolate workers.`,
    ).toBe(0);
  });
  test(`B3: workerServer teardown reclaims the per-worker ${CACHE_DIR_ENV_VAR} at both teardown sites`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(result.missingEnv).toBe(0);
    expect(
      result.missingCleanup,
      `Bind ${CACHE_DIR_ENV_VAR} to a local variable and reclaim the same resource alongside contentDir on BOTH failure and normal release paths. Recognised primitives are node:fs rmSync and teardown-fs removeAllDuringTeardown. Missing cleanup leaves orphan Vite cache directories under packages/app/node_modules.`,
    ).toBe(0);
    expect(result.teardowns).toBeGreaterThanOrEqual(2);
  });
});

const workerFixture = `import { test as base } from '@playwright/test';
  import { spawn } from 'node:child_process';
  import { mkdtempSync, rmSync } from 'node:fs';
  export const test = base.extend({ workerServer: [async ({}, use, workerInfo) => {
    const contentDir = mkdtempSync('content');
    const viteCacheDir = mkdtempSync('cache');
    spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } });
    try { await use(); } catch { rmSync(contentDir); rmSync(viteCacheDir); }
    rmSync(contentDir); rmSync(viteCacheDir);
  }, { scope: 'worker' }] });`;

const phasedFixture = `import { test as base } from '@playwright/test';
  import { spawn } from 'node:child_process';
  import { mkdtempSync, rmSync } from 'node:fs';
  async function spendOnBudgetPhase(phase, body) { return body(); }
  export const test = base.extend({ workerServer: [async ({}, use, workerInfo) => {
    let started;
    started = await spendOnBudgetPhase(0, async () => {
      const contentDir = mkdtempSync('content');
      const viteCacheDir = mkdtempSync('cache');
      const log = () => { return 0; };
      try { spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } }); }
      catch { rmSync(contentDir); rmSync(viteCacheDir); }
      return { contentDir, viteCacheDir };
    });
    const { contentDir, viteCacheDir } = started;
    await use();
    rmSync(contentDir); rmSync(viteCacheDir);
  }, { scope: 'worker' }] });`;

const helperFixture = `import { test as base } from '@playwright/test';
  import { spawn } from 'node:child_process';
  import { mkdtempSync, rmSync } from 'node:fs';
  function startServer(contentDir, viteCacheDir) {
    return spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } });
  }
  export const test = base.extend({ workerServer: [async ({}, use, workerInfo) => {
    const contentDir = mkdtempSync('content');
    const viteCacheDir = mkdtempSync('cache');
    startServer(contentDir, viteCacheDir);
    try { await use(); } catch { rmSync(contentDir); rmSync(viteCacheDir); }
    rmSync(contentDir); rmSync(viteCacheDir);
  }, { scope: 'worker' }] });`;

describe('worker cache rule self-test', () => {
  test('follows a reached exported spawn across modules and refuses a missing or disconnected implementation', () => {
    const start = helperFixture.indexOf('  function startServer');
    const end = helperFixture.indexOf('  export const test');
    const implementation = `import { spawn } from 'node:child_process';\nexport ${helperFixture.slice(start, end).trim()}`;
    const caller =
      helperFixture.slice(0, start) +
      "import { startServer } from './moved.ts';\n" +
      helperFixture.slice(end);
    const expected = {
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    };
    expect(inspectWorkerCache(caller, { '/moved.ts': implementation })).toEqual(expected);
    expect(
      inspectWorkerCache("export { test } from './registered.ts';", {
        '/registered.ts': caller,
        '/moved.ts': implementation,
      }),
    ).toEqual(expected);
    expect(inspectWorkerCache(caller).census).toContain('spawn');
    expect(
      inspectWorkerCache(caller.replace('startServer(contentDir, viteCacheDir);', ''), {
        '/moved.ts': implementation,
      }).census,
    ).toContain('spawn');
  });

  test('accounts for failure and normal reclamation through one shared cleanup helper', () => {
    const helper =
      'function reclaim(contentDir, viteCacheDir) { rmSync(contentDir); rmSync(viteCacheDir); }';
    const paired = 'rmSync(contentDir); rmSync(viteCacheDir);';
    const factored = workerFixture
      .replaceAll(paired, 'reclaim(contentDir, viteCacheDir);')
      .replace('  export const test', `${helper}\n  export const test`);
    expect(inspectWorkerCache(factored)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
    expect(
      inspectWorkerCache(
        factored.replace('catch { reclaim(contentDir, viteCacheDir); }', 'catch {}'),
      ).missingCleanup,
    ).toBe(1);
    expect(
      inspectWorkerCache(factored.replace('reclaim(contentDir, viteCacheDir);\n', '\n'))
        .missingCleanup,
    ).toBe(1);
    expect(inspectWorkerCache(factored.replace('rmSync(viteCacheDir);', '')).missingCleanup).toBe(
      2,
    );
    expect(
      inspectWorkerCache(factored.replace('rmSync(viteCacheDir);', "rmSync('other');"))
        .missingCleanup,
    ).toBe(2);
  });
  test('examines an additional bad spawn and helper call outside the runtime sample', () => {
    const spawn =
      "spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } });";
    const added = workerFixture.replace(
      spawn,
      `if (workerInfo.workerIndex === 999) { ${spawn.replace('OK_TEST_VITE_CACHE_DIR: viteCacheDir', "OK_TEST_VITE_CACHE_DIR: 'shared'")} } ${spawn}`,
    );
    expect(inspectWorkerCache(added)).toMatchObject({
      census: [],
      spawns: 2,
      nonUnique: 1,
      missingCleanup: 2,
    });
    const helper = helperFixture.replace(
      'startServer(contentDir, viteCacheDir);',
      "if (workerInfo.workerIndex === 999) startServer(contentDir, 'shared'); startServer(contentDir, viteCacheDir);",
    );
    expect(inspectWorkerCache(helper)).toMatchObject({ census: [], spawns: 2, nonUnique: 1 });
    expect(inspectWorkerCache(workerFixture)).toMatchObject({
      census: [],
      spawns: 1,
      nonUnique: 0,
      missingCleanup: 0,
    });
  });
  test('binds the cache handoff to the actual owner entry and service call', () => {
    const graph = readWorkerCacheGraph(WORKER_FIXTURES);
    const source = graph[WORKER_FIXTURES];
    expect(inspectWorkerCache(source, graph, WORKER_FIXTURES)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 3,
      teardowns: 6,
    });
    const command = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/worker-server-command.ts');
    const adapter = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/worker-server-lifetime.ts');
    const owner = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/worker-server-lifetime.cjs');
    const absentKey = graph[command].replaceAll('OK_TEST_VITE_CACHE_DIR:', 'OTHER_CACHE:');
    expect(absentKey).not.toBe(graph[command]);
    expect(
      inspectWorkerCache(source, { ...graph, [command]: absentKey }, WORKER_FIXTURES).missingEnv,
    ).toBe(3);
    const noOwnerCache = graph[owner].replace('launch.viteCacheDir,', '');
    const noFailureCache = source.replace(
      'releaseSetupResources.push(() => removeAllDuringTeardown(viteCacheDir));',
      '',
    );
    expect(noOwnerCache).not.toBe(graph[owner]);
    expect(noFailureCache).not.toBe(source);
    expect(
      inspectWorkerCache(noFailureCache, { ...graph, [owner]: noOwnerCache }, WORKER_FIXTURES)
        .missingCleanup,
    ).toBe(3);
    const missing = { ...graph };
    delete missing[owner];
    expect(inspectWorkerCache(source, missing, WORKER_FIXTURES).census).not.toEqual([]);
    expect(
      inspectWorkerCache(
        source,
        { ...graph, [owner]: graph[owner].replace('process.argv[2]', 'process.argv[3]') },
        WORKER_FIXTURES,
      ).census,
    ).not.toEqual([]);
    expect(
      inspectWorkerCache(
        source,
        {
          ...graph,
          [command]: graph[command].replaceAll(
            'OK_TEST_VITE_CACHE_DIR: viteCacheDir',
            "OK_TEST_VITE_CACHE_DIR: 'shared'",
          ),
        },
        WORKER_FIXTURES,
      ).nonUnique,
    ).toBe(3);
    expect(
      inspectWorkerCache(
        source,
        {
          ...graph,
          [adapter]: graph[adapter].replace('    viteCacheDir,', "    viteCacheDir: 'shared',"),
        },
        WORKER_FIXTURES,
      ).nonUnique,
    ).toBe(3);
  });
  test('accepts a unique reclaimed cache and rejects the adjacent shared cache', () => {
    expect(inspectWorkerCache(workerFixture)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
    expect(
      inspectWorkerCache(workerFixture.replace("mkdtempSync('cache')", "'shared'")).nonUnique,
    ).toBe(1);
    expect(
      inspectWorkerCache(
        workerFixture
          .replace("mkdtempSync('cache')", "'shared'; const OK_TEST_VITE_CACHE_DIR = viteCacheDir")
          .replace('OK_TEST_VITE_CACHE_DIR: viteCacheDir', 'OK_TEST_VITE_CACHE_DIR'),
      ),
    ).toMatchObject({ missingEnv: 0, nonUnique: 1, missingCleanup: 0 });
    for (const shared of [
      "prepareViteCacheDir('shared')",
      "'cache-' + ({ workerIndex: 0 }).workerIndex",
    ]) {
      expect(
        inspectWorkerCache(workerFixture.replace("mkdtempSync('cache')", shared)).nonUnique,
        shared,
      ).toBe(1);
    }
  });
  test('requires the spawn entry and both cleanup sites', () => {
    expect(
      inspectWorkerCache(workerFixture.replace('OK_TEST_VITE_CACHE_DIR:', 'OTHER:')).missingEnv,
    ).toBe(1);
    expect(
      inspectWorkerCache(workerFixture.replace('rmSync(viteCacheDir);', '')).missingCleanup,
    ).toBe(1);
    expect(
      inspectWorkerCache(workerFixture.replace('rmSync(viteCacheDir);\n', '\n')).missingCleanup,
    ).toBe(1);
  });
  test('reads the setup phase result past a nested block-bodied return', () => {
    expect(inspectWorkerCache(phasedFixture)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
  });
  test('follows the spawn into a same-module helper the fixture calls and reads the call arguments', () => {
    expect(inspectWorkerCache(helperFixture)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
    expect(
      inspectWorkerCache(
        helperFixture.replace(
          'startServer(contentDir, viteCacheDir);',
          "startServer(contentDir, 'shared');",
        ),
      ).nonUnique,
    ).toBe(1);
    expect(
      inspectWorkerCache(
        helperFixture.replace(
          'OK_TEST_VITE_CACHE_DIR: viteCacheDir',
          "OK_TEST_VITE_CACHE_DIR: 'shared'",
        ),
      ).nonUnique,
    ).toBe(1);
    expect(
      inspectWorkerCache(
        helperFixture.replace(
          'startServer(contentDir, viteCacheDir);',
          "startServer(contentDir, 'shared'); startServer(contentDir, viteCacheDir);",
        ),
      ).nonUnique,
    ).toBe(1);
    expect(
      inspectWorkerCache(helperFixture.replace('startServer(contentDir, viteCacheDir);', ''))
        .census,
    ).toEqual(['spawn']);
  });
  test('ignores comments and refuses a forwarding or unparseable fixture', () => {
    expect(
      inspectWorkerCache(`${workerFixture} /* OK_TEST_VITE_CACHE_DIR: 'shared' */`).nonUnique,
    ).toBe(0);
    expect(inspectWorkerCache("export {test} from './moved.ts';").census).toEqual([
      'test',
      'extend',
      'workerServer',
      'workerInfo',
      'spawn',
    ]);
    expect(inspectWorkerCache(`${workerFixture} const = ;`).census).toEqual(['syntax']);
  });
});
