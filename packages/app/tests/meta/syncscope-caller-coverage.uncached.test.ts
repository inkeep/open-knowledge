import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Symbol as MorphSymbol, Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';

const SERVER_SRC_ROOT = join(import.meta.dirname, '../../../server/src');
const CLI_SRC_ROOT = join(import.meta.dirname, '../../../cli/src');
const APP_SRC_ROOT = join(import.meta.dirname, '../../src');
const CONTENT_FILTER_PATH = join(SERVER_SRC_ROOT, 'content-filter.ts');
const SYNC_ENGINE_PATH = join(SERVER_SRC_ROOT, 'sync-engine.ts');

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (
      st.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !isTestOnlySourceFile(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('syncScope caller coverage', () => {
  test('no server/cli/app production file outside the sanctioned files names syncScope', () => {
    const allowedFiles = new Set([CONTENT_FILTER_PATH, SYNC_ENGINE_PATH]);
    const offenders: string[] = [];
    for (const root of [SERVER_SRC_ROOT, CLI_SRC_ROOT, APP_SRC_ROOT]) {
      for (const file of listProductionTsFiles(root)) {
        if (allowedFiles.has(file)) continue;
        if (/\bsyncScope\b/.test(readFileSync(file, 'utf8'))) {
          offenders.push(
            `${file} — syncScope outside the sanctioned set. Only the sync engine's ` +
              'gather / head-listing staging paths may pass the flag; a new consumer ' +
              'needs a deliberate spec decision AND an allowlist entry here.',
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the sanctioned surface still exists (allowlist-rot guard)', () => {
    assertSyncReadOptions(readFileSync(CONTENT_FILTER_PATH, 'utf8'));
  });

  test('the conflict partition inside sync-engine.ts stays unscoped', () => {
    assertConflictPartition(
      readFileSync(SYNC_ENGINE_PATH, 'utf8'),
      readFileSync(CONTENT_FILTER_PATH, 'utf8'),
    );
  });
});

function parsedSources(sources: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, noLib: true },
  });
  for (const [name, source] of Object.entries(sources)) {
    project.createSourceFile(name, source);
  }
  expect(project.getProgram().getSyntacticDiagnostics()).toEqual([]);
  return project;
}

function assertSyncReadOptions(source: string): void {
  const file = parsedSources({ 'content-filter.ts': source }).getSourceFileOrThrow(
    'content-filter.ts',
  );
  const declaration = file.getTypeAliasOrThrow('ContentFilterSyncReadOpts');
  const options = declaration.getType();
  const scope = options.getPropertyOrThrow('syncScope');
  expect(scope.isOptional()).toBe(false);
  const declarations = scope.getDeclarations();
  expect(declarations, `syncScope is declared once, found ${declarations.length}`).toHaveLength(1);
  let owner: Node = declarations[0].getParentOrThrow();
  while (Node.isTypeLiteral(owner) || Node.isIntersectionTypeNode(owner))
    owner = owner.getParentOrThrow();
  expect(
    owner,
    `syncScope is declared directly on ContentFilterSyncReadOpts, found ${owner.getKindName()}${Node.hasName(owner) ? ` ${owner.getName()}` : ''} at line ${owner.getStartLineNumber()}`,
  ).toBe(declaration);
  const members = declarations.flatMap((declaration) => {
    const type = Node.isPropertySignature(declaration) ? declaration.getTypeNode() : declaration;
    return Node.isTypeLiteral(type)
      ? type
          .getMembers()
          .map((member) =>
            Node.isPropertySignature(member) ? member.getName() : member.getKindName(),
          )
      : [`${(type ?? declaration).getKindName()} where an inline { pathBase } literal is required`];
  });
  expect(
    members,
    `syncScope declares only pathBase, found ${members.join(', ') || 'no members'}`,
  ).toEqual(['pathBase']);
  const base = scope.getTypeAtLocation(declaration).getPropertyOrThrow('pathBase');
  expect(base.isOptional()).toBe(false);
  expect(
    base
      .getTypeAtLocation(declaration)
      .getUnionTypes()
      .map((type) => type.getLiteralValue())
      .sort(),
  ).toEqual(['content', 'project']);
  const bypass = options.getPropertyOrThrow('bypassFilters');
  expect(bypass.isOptional()).toBe(true);
  expect(bypass.getTypeAtLocation(declaration).isUndefined()).toBe(true);
}

function unwrap(node: Node): Node {
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isExpressionWithTypeArguments(node)
  )
    node = node.getExpression();
  return node;
}

function hasOptionalCallee(node: Node, seen = new Set<Node>()): boolean {
  node = unwrap(node);
  if (seen.has(node)) return false;
  seen.add(node);
  if (
    Node.isCallExpression(node) ||
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node)
  ) {
    return node.hasQuestionDotToken() || hasOptionalCallee(node.getExpression(), seen);
  }
  return declarationsOf(node).some((declaration) =>
    Node.isVariableDeclaration(declaration) && declaration.getInitializer() !== undefined
      ? hasOptionalCallee(declaration.getInitializerOrThrow(), seen)
      : false,
  );
}

function declarationsOf(node: Node): Node[] {
  const symbol = node.getSymbol();
  if (!symbol) return [];
  return (symbol.getAliasedSymbol() ?? symbol).getDeclarations();
}

function callsSymbol(node: Node, target: MorphSymbol, seen = new Set<Node>()): boolean {
  node = unwrap(node);
  if (seen.has(node)) return false;
  seen.add(node);
  const symbol = node.getSymbol();
  if (symbol === target || symbol?.getAliasedSymbol() === target) return true;
  return declarationsOf(node).some((declaration) =>
    Node.isVariableDeclaration(declaration) && declaration.getInitializer() !== undefined
      ? callsSymbol(declaration.getInitializerOrThrow(), target, seen)
      : false,
  );
}

function forbiddenReferences(
  method: Node,
  file: SourceFile,
  banned: string[],
  followCallBodies: boolean,
): string[] {
  const seen = new Set<Node>();
  const found = new Set<string>();
  const visit = (root: Node): void => {
    if (seen.has(root)) return;
    seen.add(root);
    for (const node of [root, ...root.getDescendants()]) {
      let name: string;
      if (
        Node.isIdentifier(node) ||
        Node.isPrivateIdentifier(node) ||
        Node.isRegularExpressionLiteral(node)
      )
        name = node.getText();
      else if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
        name = node.getLiteralValue();
      else if (
        Node.isTemplateHead(node) ||
        Node.isTemplateMiddle(node) ||
        Node.isTemplateTail(node)
      )
        name = node.getLiteralText();
      else continue;
      const names = [name];
      const declarations = declarationsOf(node);
      for (const declaration of declarations) {
        const symbol = declaration.getSymbol();
        if (symbol) names.push(symbol.getName());
        if (declaration.getSourceFile() !== file) continue;
        if (
          Node.isVariableDeclaration(declaration) ||
          Node.isPropertyDeclaration(declaration) ||
          Node.isPropertyAssignment(declaration)
        ) {
          const initializer = declaration.getInitializer();
          if (initializer) visit(initializer);
        } else if (Node.isBindingElement(declaration)) {
          const initializer = declaration
            .getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
            ?.getInitializer();
          if (initializer) visit(initializer);
        } else if (
          Node.isGetAccessorDeclaration(declaration) ||
          Node.isSetAccessorDeclaration(declaration) ||
          (followCallBodies &&
            (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)))
        ) {
          const body = declaration.getBody();
          if (body) visit(body);
        }
      }
      for (const name of names) {
        for (const forbidden of banned)
          if (name.includes(forbidden))
            found.add(`${forbidden} at line ${node.getStartLineNumber()}`);
      }
    }
  };
  visit(method);
  return [...found].sort();
}

function assertConflictPartition(source: string, filter: string): void {
  const project = parsedSources({ 'sync-engine.ts': source, 'content-filter.ts': filter });
  const file = project.getSourceFileOrThrow('sync-engine.ts');
  const engine = file.getClassOrThrow('SyncEngine');
  const predicate = engine.getMethodOrThrow('isContentConflictPath');
  const handler = engine.getMethodOrThrow('handleMergeConflict');
  const excluded = project
    .getSourceFileOrThrow('content-filter.ts')
    .getInterfaceOrThrow('ContentFilter')
    .getMethodOrThrow('isExcluded')
    .getSymbolOrThrow();
  for (const [method, target, banned] of [
    [predicate, excluded, ['isShareableOkArtifact', 'SYNC_STAGING_SCOPE', 'syncScope']],
    [handler, predicate.getSymbolOrThrow(), ['SYNC_STAGING_SCOPE', 'syncScope']],
  ] as const) {
    expect(method.getBody()).toBeDefined();
    const calls = method
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => !hasOptionalCallee(call) && callsSymbol(call.getExpression(), target));
    expect(
      calls.length,
      `${method.getName()}: required non-optional call resolving to ${target.getName()} in ${target.getDeclarations()[0]?.getSourceFile().getBaseName()}`,
    ).toBeGreaterThan(0);
    if (method === handler) {
      expect(
        calls.some((call) => {
          const expression = unwrap(call.getExpression());
          if (
            !Node.isPropertyAccessExpression(expression) ||
            unwrap(expression.getExpression()).getKind() !== SyntaxKind.ThisKeyword ||
            call.getArguments().length !== 1
          )
            return false;
          const loop = call.getFirstAncestorByKind(SyntaxKind.ForOfStatement);
          const argument = call.getArguments()[0];
          if (!loop || !argument) return false;
          const declaration = loop
            .getInitializer()
            .getFirstDescendantByKind(SyntaxKind.VariableDeclaration);
          const binding = declaration?.getSymbol();
          return binding !== undefined && unwrap(argument).getSymbol() === binding;
        }),
        'the handler passes its conflict-loop variable',
      ).toBe(true);
    }
    expect(
      forbiddenReferences(method, file, [...banned], method === predicate),
      method.getName(),
    ).toEqual([]);
  }
}

const FILTER_FIXTURE = `
export type ContentFilterSyncReadOpts = {
  bypassFilters?: never;
  syncScope: { pathBase: 'content' | 'project' };
};
export interface ContentFilter { isExcluded(path: string): boolean; }
export function isShareableOkArtifact(path: string) { return false; }
`;
const ENGINE_FIXTURE = `
import { type ContentFilter, isShareableOkArtifact as artifact } from './content-filter';
const CONTENT_SYNC_STAGING_SCOPE = { syncScope: { pathBase: 'content' } };
const scopeAlias = CONTENT_SYNC_STAGING_SCOPE;
export class SyncEngine {
  contentFilter: ContentFilter;
  private isContentConflictPath(file: string) { return !this.contentFilter.isExcluded(file); }
  private async handleMergeConflict() { for (const file of ['a.md']) { this.isContentConflictPath(file); } }
}
`;

describe('syncScope structural rule self-tests', () => {
  test('checks the option type and rejects a widened bypass', () => {
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
    expect(() =>
      assertSyncReadOptions(
        FILTER_FIXTURE.replace('bypassFilters?: never', 'bypassFilters?: boolean'),
      ),
    ).toThrow();
  });

  test.each([
    ['syncScope: {', 'syncScope?: {'],
    ["pathBase: 'content' | 'project'", 'pathBase: string'],
    ["pathBase: 'content' | 'project'", "pathBase: 'content' | 'project' | 'other'"],
    ['bypassFilters?: never;', ''],
  ])('rejects a changed sync option contract: %s', (before, after) => {
    expect(() => assertSyncReadOptions(FILTER_FIXTURE.replace(before, after))).toThrow();
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
  });

  test.each([
    ["{ pathBase: 'content' | 'project'; reveal?: boolean }", 'pathBase, reveal'],
    ["{ pathBase: 'content' | 'project'; [key: string]: unknown }", 'pathBase, IndexSignature'],
    ["{ pathBase: 'content' | 'project'; reveal(): void }", 'pathBase, MethodSignature'],
    ["{ pathBase: 'content' | 'project'; (): void }", 'pathBase, CallSignature'],
    ["{ pathBase: 'content' } | { pathBase: 'project'; reveal?: boolean }", 'UnionType'],
    ['{}', 'no members'],
  ])('requires the declared syncScope member set: %s', (shape, found) => {
    expect(() =>
      assertSyncReadOptions(FILTER_FIXTURE.replace("{ pathBase: 'content' | 'project' }", shape)),
    ).toThrow(`syncScope declares only pathBase, found ${found}`);
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
  });

  test('requires the scope declaration to belong directly to the option alias', () => {
    const source = `
      type ContentFilterSyncReadOpts = {
        [K in keyof { syncScope: { pathBase: 'content' | 'project' } }]:
          { syncScope: { pathBase: 'content' | 'project' } }[K] & { reveal?: boolean };
      } & { bypassFilters?: never };
    `;
    expect(() => assertSyncReadOptions(source)).toThrow(
      'declared directly on ContentFilterSyncReadOpts, found TypeOperator at line 3',
    );
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
  });

  test('requires a single syncScope declaration', () => {
    expect(() =>
      assertSyncReadOptions(FILTER_FIXTURE.replace('\n};', '\n} & { syncScope: {} };')),
    ).toThrow('syncScope is declared once, found 2');
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
  });

  test.each([
    {
      shape: 'an extracted literal',
      source: `${FILTER_FIXTURE.replace("{ pathBase: 'content' | 'project' }", 'SyncScopeShape')}type SyncScopeShape = { pathBase: 'content' | 'project' };`,
      message:
        'syncScope declares only pathBase, found TypeReference where an inline { pathBase } literal is required',
    },
    {
      shape: 'a holder alias',
      source:
        "type Holder = { syncScope: { pathBase: 'content' | 'project' } };\ntype ContentFilterSyncReadOpts = { bypassFilters?: never } & Holder;",
      message:
        'syncScope is declared directly on ContentFilterSyncReadOpts, found TypeAliasDeclaration Holder at line 1',
    },
  ])('names the rule and what it found for $shape', ({ source, message }) => {
    expect(() => assertSyncReadOptions(source)).toThrow(message);
    expect(() => assertSyncReadOptions(FILTER_FIXTURE)).not.toThrow();
  });

  test.each([
    ['isContentConflictPath', '#syncScope', 'undefined'],
    ['handleMergeConflict', '#syncScope', 'undefined'],
    ['isContentConflictPath', '#scope', 'scopeAlias'],
    ['handleMergeConflict', '#scope', 'scopeAlias'],
  ])('checks private member names and values in %s: %s', (method, member, value) => {
    const anchor =
      method === 'isContentConflictPath'
        ? 'return !this.contentFilter'
        : "for (const file of ['a.md'])";
    const source = ENGINE_FIXTURE.replace(
      'export class SyncEngine {',
      `export class SyncEngine { readonly ${member} = ${value};`,
    ).replace(anchor, `void this.${member}; ${anchor}`);
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow(method);
    const safe = source
      .replaceAll('#syncScope', '#ordinary')
      .replace('= scopeAlias;', '= undefined;');
    expect(() => assertConflictPartition(safe, FILTER_FIXTURE)).not.toThrow();
  });

  test.each(['isContentConflictPath', 'handleMergeConflict'])(
    'rejects an external staging-scope name in %s',
    (method) => {
      const anchor =
        method === 'isContentConflictPath'
          ? 'return !this.contentFilter'
          : "for (const file of ['a.md'])";
      const source =
        `import { EXTERNAL_SYNC_STAGING_SCOPE } from './outside'; ${ENGINE_FIXTURE}`.replace(
          anchor,
          `void EXTERNAL_SYNC_STAGING_SCOPE; ${anchor}`,
        );
      expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow('SYNC_STAGING_SCOPE');
      expect(() =>
        assertConflictPartition(
          source.replaceAll('EXTERNAL_SYNC_STAGING_SCOPE', 'EXTERNAL_OPTIONS'),
          FILTER_FIXTURE,
        ),
      ).not.toThrow();
    },
  );

  test.each([
    ['private extra = scopeAlias;', '', 'this.extra'],
    [
      '',
      'const CONFIG = { extra: scopeAlias }; declare const options: typeof CONFIG;',
      'options.extra',
    ],
    ['', 'function partitionScope() { return scopeAlias; }', 'partitionScope()'],
  ])('follows a partition value dependency: %s %s', (member, declaration, expression) => {
    const source =
      ENGINE_FIXTURE.replace(
        'export class SyncEngine {',
        `export class SyncEngine { ${member}`,
      ).replace('return !this.contentFilter', `void ${expression}; return !this.contentFilter`) +
      declaration;
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow('isContentConflictPath');
    expect(() =>
      assertConflictPartition(
        source.replace(
          'const scopeAlias = CONTENT_SYNC_STAGING_SCOPE;',
          'const scopeAlias = undefined;',
        ),
        FILTER_FIXTURE,
      ),
    ).not.toThrow();
  });

  test('checks optional receivers through a local callee alias', () => {
    const source = ENGINE_FIXTURE.replace(
      'return !this.contentFilter.isExcluded(file);',
      'const excluded = this.contentFilter?.isExcluded; return !excluded(file);',
    );
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow('non-optional');
    expect(() =>
      assertConflictPartition(source.replace('?.isExcluded', '.isExcluded'), FILTER_FIXTURE),
    ).not.toThrow();
  });

  test.each([
    'this.contentFilter?.isExcluded(file)',
    'this?.contentFilter.isExcluded(file)',
    '(this.contentFilter?.isExcluded)!(file)',
    "this?.['contentFilter'].isExcluded(file)",
    'this?.isContentConflictPath(file)',
  ])('rejects receiver-side optional chains: %s', (expression) => {
    const original = expression.includes('isExcluded')
      ? 'this.contentFilter.isExcluded(file)'
      : 'this.isContentConflictPath(file)';
    expect(() =>
      assertConflictPartition(ENGINE_FIXTURE.replace(original, expression), FILTER_FIXTURE),
    ).toThrow();
    expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
  });

  test.each(['isContentConflictPath', 'handleMergeConflict'])(
    'bounds call-body traversal from %s',
    (name) => {
      const source = ENGINE_FIXTURE.replace(
        name === 'isContentConflictPath'
          ? 'return !this.contentFilter'
          : "for (const file of ['a.md'])",
        name === 'isContentConflictPath'
          ? 'this.helper(); return !this.contentFilter'
          : "this.helper(); for (const file of ['a.md'])",
      ).replace(
        'export class SyncEngine {',
        "export class SyncEngine { private helper() { void 'syncScope'; }",
      );
      const project = parsedSources({
        'sync-engine.ts': source,
        'content-filter.ts': FILTER_FIXTURE,
      });
      const file = project.getSourceFileOrThrow('sync-engine.ts');
      const method = file.getClassOrThrow('SyncEngine').getMethodOrThrow(name);
      const reference = file
        .getDescendantsOfKind(SyntaxKind.StringLiteral)
        .find((node) => node.getLiteralValue() === 'syncScope');
      expect(reference).toBeDefined();
      expect(
        forbiddenReferences(method, file, ['syncScope'], name === 'isContentConflictPath'),
      ).toEqual(
        name === 'isContentConflictPath'
          ? [`syncScope at line ${reference?.getStartLineNumber()}`]
          : [],
      );
      expect(() =>
        assertConflictPartition(source.replace("'syncScope'", "'ordinary'"), FILTER_FIXTURE),
      ).not.toThrow();
    },
  );

  test('applies call-body bounds when checking the conflict partition', () => {
    const source = ENGINE_FIXTURE.replace(
      'export class SyncEngine {',
      "export class SyncEngine { private partitionHelper() { void 'syncScope'; }",
    );
    const predicate = source.replace(
      'return !this.contentFilter',
      'this.partitionHelper(); return !this.contentFilter',
    );
    const handler = source.replace(
      "for (const file of ['a.md'])",
      "this.partitionHelper(); for (const file of ['a.md'])",
    );
    expect(() => assertConflictPartition(predicate, FILTER_FIXTURE)).toThrow('syncScope');
    expect(() => assertConflictPartition(handler, FILTER_FIXTURE)).not.toThrow();
  });

  test.each([
    ['isContentConflictPath', 'get'],
    ['isContentConflictPath', 'set'],
    ['handleMergeConflict', 'get'],
    ['handleMergeConflict', 'set'],
  ])('follows value accessor bodies from %s: %s', (name, kind) => {
    const access = kind === 'get' ? 'void this.extra;' : 'this.extra = true;';
    const body =
      kind === 'get'
        ? "get extra() { void 'syncScope'; return true; }"
        : "set extra(_value: boolean) { void 'syncScope'; }";
    const source = ENGINE_FIXTURE.replace(
      'export class SyncEngine {',
      `export class SyncEngine { ${body}`,
    ).replace(
      name === 'isContentConflictPath'
        ? 'return !this.contentFilter'
        : "for (const file of ['a.md'])",
      name === 'isContentConflictPath'
        ? `${access} return !this.contentFilter`
        : `${access} for (const file of ['a.md'])`,
    );
    const project = parsedSources({
      'sync-engine.ts': source,
      'content-filter.ts': FILTER_FIXTURE,
    });
    const file = project.getSourceFileOrThrow('sync-engine.ts');
    const method = file.getClassOrThrow('SyncEngine').getMethodOrThrow(name);
    const reference = file
      .getDescendantsOfKind(SyntaxKind.StringLiteral)
      .find((node) => node.getLiteralValue() === 'syncScope');
    expect(reference).toBeDefined();
    expect(
      forbiddenReferences(method, file, ['syncScope'], name === 'isContentConflictPath'),
    ).toEqual([`syncScope at line ${reference?.getStartLineNumber()}`]);
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow();
    expect(() =>
      assertConflictPartition(source.replace("'syncScope'", "'ordinary'"), FILTER_FIXTURE),
    ).not.toThrow();
  });

  test('accepts unrelated re-exports beside complete local declarations', () => {
    const extra = "export { unrelated } from './other';";
    expect(() => assertSyncReadOptions(FILTER_FIXTURE + extra)).not.toThrow();
    expect(() =>
      assertConflictPartition(ENGINE_FIXTURE + extra, FILTER_FIXTURE + extra),
    ).not.toThrow();
    expect(() =>
      assertSyncReadOptions("export type { ContentFilterSyncReadOpts } from './other';"),
    ).toThrow();
  });

  test('accepts the unscoped partition and rejects missing calls', () => {
    expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
    for (const expression of [
      'this.contentFilter.isExcluded(file)',
      'this.isContentConflictPath(file)',
    ]) {
      expect(() =>
        assertConflictPartition(ENGINE_FIXTURE.replace(expression, 'true'), FILTER_FIXTURE),
      ).toThrow();
    }
  });

  test.each([
    "this.isContentConflictPath('other.md')",
    'this.isContentConflictPath(file, true)',
    'new SyncEngine().isContentConflictPath(file)',
  ])('requires this instance and exactly its conflict-loop variable: %s', (call) => {
    expect(() =>
      assertConflictPartition(
        ENGINE_FIXTURE.replace('this.isContentConflictPath(file)', call),
        FILTER_FIXTURE,
      ),
    ).toThrow();
    expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
  });

  test.each(['artifact(file)', 'scopeAlias', '({ syncScope: true })'])(
    'rejects an alias or scope reference: %s',
    (expression) => {
      const source = ENGINE_FIXTURE.replace(
        'return !this.contentFilter',
        `void ${expression}; return !this.contentFilter`,
      );
      expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow();
      expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
    },
  );

  test.each([
    'const { value: localAlias } = { value: scopeAlias };',
    'const [localAlias] = [scopeAlias];',
    'const container = { value: scopeAlias }; const { value: localAlias } = container;',
  ])('follows destructured aliases: %s', (declaration) => {
    const source = ENGINE_FIXTURE.replace(
      'return !this.contentFilter',
      'void localAlias; return !this.contentFilter',
    );
    expect(() => assertConflictPartition(source + declaration, FILTER_FIXTURE)).toThrow();
    expect(() =>
      assertConflictPartition(
        source + declaration.replace('scopeAlias', 'undefined'),
        FILTER_FIXTURE,
      ),
    ).not.toThrow();
  });

  test.each(['this.contentFilter.isExcluded', 'this.isContentConflictPath'])(
    'requires a non-optional call: %s',
    (callee) => {
      expect(() =>
        assertConflictPartition(
          ENGINE_FIXTURE.replace(`${callee}(file)`, `${callee}?.(file)`),
          FILTER_FIXTURE,
        ),
      ).toThrow();
      expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
    },
  );

  test.each([
    '({ [`syncScope`]: true })',
    `({ [\`syncScope\${empty}\`]: true })`,
    '({ [/syncScope/.source]: true })',
    `\`before\${empty}syncScope\${empty}after\``,
    `\`before\${empty}syncScope\``,
  ])('rejects scope keys represented by literal syntax: %s', (expression) => {
    const source = ENGINE_FIXTURE.replace(
      'return !this.contentFilter',
      `void ${expression}; return !this.contentFilter`,
    );
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow();
    expect(() =>
      assertConflictPartition(source.replaceAll('syncScope', 'ordinaryOption'), FILTER_FIXTURE),
    ).not.toThrow();
  });

  test('does not equate two unresolved argument and binding symbols', () => {
    const source = ENGINE_FIXTURE.replace(
      "for (const file of ['a.md'])",
      "for (const { file } of [{ file: 'a.md' }])",
    ).replace('this.isContentConflictPath(file)', "this.isContentConflictPath('wrong.md')");
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow();
    expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
  });

  test.each([
    '(this.contentFilter.isExcluded)',
    '(this.contentFilter.isExcluded as typeof this.contentFilter.isExcluded)',
    '(this.contentFilter.isExcluded satisfies Function)',
    '(this.contentFilter.isExcluded!)',
    '(<Function>this.contentFilter.isExcluded)',
    '(this.contentFilter.isExcluded<string>)',
  ])('follows call wrappers: %s', (expression) => {
    const source = ENGINE_FIXTURE.replace(
      'this.contentFilter.isExcluded(file)',
      `${expression}(file)`,
    );
    expect(() => assertConflictPartition(source, FILTER_FIXTURE)).not.toThrow();
    expect(() =>
      assertConflictPartition(source.replace(`${expression}(file)`, 'true'), FILTER_FIXTURE),
    ).toThrow();
  });

  test('rejects missing local declarations and syntactically invalid files', () => {
    for (const source of ["export { SyncEngine } from './moved';", `${ENGINE_FIXTURE} const = ;`]) {
      expect(() => assertConflictPartition(source, FILTER_FIXTURE)).toThrow();
    }
    expect(() => assertConflictPartition(ENGINE_FIXTURE, FILTER_FIXTURE)).not.toThrow();
  });
});
