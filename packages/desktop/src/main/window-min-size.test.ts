import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
  SyntaxKind,
  VariableDeclarationKind,
} from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { WINDOW_MIN_SIZE } from './window-min-size.ts';

describe('WINDOW_MIN_SIZE constants', () => {
  test('declares EDITOR with a usable minimum width', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeGreaterThanOrEqual(320);
  });

  test('declares EDITOR with a usable minimum height', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.height).toBeGreaterThanOrEqual(240);
  });

  test('declares NAVIGATOR with a usable minimum width', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.width).toBeGreaterThanOrEqual(320);
  });

  test('declares NAVIGATOR with a usable minimum height', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.height).toBeGreaterThanOrEqual(240);
  });

  test('EDITOR min width is at least as large as NAVIGATOR min width (wider chrome)', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeGreaterThanOrEqual(WINDOW_MIN_SIZE.NAVIGATOR.width);
  });

  test('min sizes leave headroom under initial Editor size (1280 x 800)', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeLessThan(1280);
    expect(WINDOW_MIN_SIZE.EDITOR.height).toBeLessThan(800);
  });

  test('min sizes leave headroom under initial Navigator size (920 x 680)', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.width).toBeLessThan(920);
    expect(WINDOW_MIN_SIZE.NAVIGATOR.height).toBeLessThan(680);
  });
});

function isMember(node: Node | undefined, path: readonly string[]): boolean {
  if (node === undefined) return false;
  const [head, ...tail] = path;
  if (tail.length === 0) return Node.isIdentifier(node) && node.getText() === head;
  return (
    Node.isPropertyAccessExpression(node) &&
    !node.hasQuestionDotToken() &&
    node.getName() === path.at(-1) &&
    isMember(node.getExpression(), path.slice(0, -1))
  );
}

function optionName(property: ObjectLiteralElementLike): string | undefined {
  if (Node.isSpreadAssignment(property)) return undefined;
  const name = property.getNameNode();
  if (Node.isStringLiteral(name)) return name.getLiteralValue();
  if (Node.isComputedPropertyName(name)) {
    const expression = name.getExpression();
    return Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)
      ? expression.getLiteralValue()
      : '<computed>';
  }
  return name.getText();
}

const windowFactories = new Map([
  ['WindowManager', 'EDITOR'],
  ['createNavigatorWindow', 'NAVIGATOR'],
  ['createTerminalWindow', 'EDITOR'],
  ['openNoteWindow', 'EDITOR'],
  ['createSlidesWindow', 'EDITOR'],
]);

function namedBindings(file: SourceFile, name: string): Node[] {
  const bindings: Node[] = [];
  for (const declaration of file.getImportDeclarations()) {
    for (const node of [
      declaration.getDefaultImport(),
      declaration.getNamespaceImport(),
      ...declaration
        .getNamedImports()
        .map((specifier) => specifier.getAliasNode() ?? specifier.getNameNode()),
    ]) {
      if (node?.getText() === name) bindings.push(node);
    }
  }
  for (const node of file.getDescendants()) {
    if (
      (Node.isVariableDeclaration(node) ||
        Node.isBindingElement(node) ||
        Node.isParameterDeclaration(node) ||
        Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isClassDeclaration(node) ||
        Node.isClassExpression(node) ||
        Node.isTypeAliasDeclaration(node) ||
        Node.isInterfaceDeclaration(node) ||
        Node.isEnumDeclaration(node) ||
        Node.isTypeParameterDeclaration(node) ||
        Node.isModuleDeclaration(node) ||
        Node.isImportEqualsDeclaration(node)) &&
      node.getNameNode()?.getText() === name
    )
      bindings.push(node);
  }
  return bindings;
}

function windowMinSizeViolations(source: string): string[] {
  const windowProject = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { noLib: true },
  });
  const file = windowProject.createSourceFile('/index.ts', source, { overwrite: true });
  try {
    const syntax = windowProject.getProgram().getSyntacticDiagnostics(file);
    if (syntax.length !== 0)
      return syntax.map((error) => `syntax: ${error.getCode()} at ${error.getStart()}`);
    const violations: string[] = [];
    const specifiers = file
      .getImportDeclarations()
      .filter(
        (declaration) =>
          declaration.getModuleSpecifierValue() === './window-min-size.ts' &&
          !declaration.isTypeOnly(),
      )
      .flatMap((declaration) => declaration.getNamedImports())
      .filter(
        (specifier) =>
          specifier.getName() === 'WINDOW_MIN_SIZE' &&
          !specifier.isTypeOnly() &&
          (specifier.getAliasNode()?.getText() ?? specifier.getName()) === 'WINDOW_MIN_SIZE',
      );
    if (specifiers.length !== 1) violations.push('WINDOW_MIN_SIZE import');
    const minimumBindings = namedBindings(file, 'WINDOW_MIN_SIZE');
    const importBinding = specifiers[0]?.getAliasNode() ?? specifiers[0]?.getNameNode();
    if (minimumBindings.length !== 1 || minimumBindings[0] !== importBinding) {
      violations.push('WINDOW_MIN_SIZE binding census');
    }
    const defaultsBindings = namedBindings(file, 'DEFAULT_WIN_OPTS');
    const defaultsDeclaration = file.getVariableDeclaration('DEFAULT_WIN_OPTS');
    const defaultsStatement = defaultsDeclaration?.getVariableStatement();
    const defaults = defaultsDeclaration?.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
    if (
      defaultsBindings.length !== 1 ||
      defaultsBindings[0] !== defaultsDeclaration ||
      defaultsStatement?.getParent() !== file ||
      defaultsStatement?.getDeclarationKind() !== VariableDeclarationKind.Const ||
      !defaults
    ) {
      violations.push('DEFAULT_WIN_OPTS declaration census');
    }
    const checkMinimum = (
      options: ObjectLiteralExpression | undefined,
      label: string,
      expected: Record<'minWidth' | 'minHeight', readonly string[]>,
      inherit = false,
    ) => {
      const properties = options?.getProperties() ?? [];
      if (properties.some((property) => optionName(property) === '<computed>')) {
        violations.push(`${label} computed option`);
      }
      const omitBoth =
        inherit &&
        !properties.some((property) =>
          ['minWidth', 'minHeight'].includes(optionName(property) ?? ''),
        );
      for (const key of ['minWidth', 'minHeight'] as const) {
        if (omitBoth) continue;
        const matches = properties.filter((property) => optionName(property) === key);
        const property = matches[0];
        if (
          matches.length !== 1 ||
          !Node.isPropertyAssignment(property) ||
          !isMember(property.getInitializer(), expected[key])
        )
          violations.push(`${label}.${key}`);
        if (
          property &&
          properties.some(
            (spread) => Node.isSpreadAssignment(spread) && spread.getStart() > property.getStart(),
          )
        )
          violations.push(`${label} spread after ${key}`);
      }
    };
    const constantPaths = (member: string) => ({
      minWidth: ['WINDOW_MIN_SIZE', member, 'width'],
      minHeight: ['WINDOW_MIN_SIZE', member, 'height'],
    });
    checkMinimum(defaults, 'DEFAULT_WIN_OPTS', constantPaths('NAVIGATOR'));
    const counts = new Map<string, number>();
    const checkedOptions = new Set<ObjectLiteralExpression>();
    const constructors = file.getDescendantsOfKind(SyntaxKind.NewExpression).filter((node) => {
      const expression = node.getExpression();
      return (
        (Node.isIdentifier(expression) && expression.getText() === 'BrowserWindow') ||
        (Node.isPropertyAccessExpression(expression) && expression.getName() === 'BrowserWindow')
      );
    });
    for (const windowConstruction of constructors) {
      const factory = windowConstruction.getFirstAncestor(
        (ancestor) => Node.isPropertyAssignment(ancestor) && ancestor.getName() === 'createWindow',
      );
      const owner = factory?.getParent()?.getParent();
      const expression =
        owner && (Node.isCallExpression(owner) || Node.isNewExpression(owner))
          ? owner.getExpression()
          : undefined;
      const label =
        expression && Node.isIdentifier(expression)
          ? expression.getText()
          : windowConstruction.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName();
      const utility = label === 'createDesktopUninstallUtilityWindow' && !factory;
      const member = label === undefined ? undefined : windowFactories.get(label);
      if (label === undefined || (!utility && member === undefined)) {
        violations.push(`unaccounted BrowserWindow: ${label ?? '<unknown>'}`);
        continue;
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
      const options = windowConstruction.getArguments()[0];
      if (!Node.isObjectLiteralExpression(options)) {
        violations.push(`${label} options`);
        continue;
      }
      checkedOptions.add(options);
      if (utility) {
        checkMinimum(options, label, {
          minWidth: ['options', 'minWidth'],
          minHeight: ['options', 'minHeight'],
        });
        continue;
      }
      const spreads = options.getProperties().filter(Node.isSpreadAssignment);
      const defaultsSpreads = spreads.filter((spread) =>
        isMember(spread.getExpression(), ['DEFAULT_WIN_OPTS']),
      );
      if (defaultsSpreads.length !== 1) violations.push(`${label} DEFAULT_WIN_OPTS spread`);
      if (member === 'NAVIGATOR' && spreads.length !== defaultsSpreads.length) {
        violations.push(`${label} additional spread`);
      }
      checkMinimum(
        options,
        label,
        constantPaths(member ?? ''),
        member === 'NAVIGATOR' && defaultsSpreads.length === 1,
      );
    }
    for (const label of [...windowFactories.keys(), 'createDesktopUninstallUtilityWindow']) {
      if (counts.get(label) !== 1) violations.push(`${label} constructor count`);
    }
    for (const reference of defaultsDeclaration?.findReferencesAsNodes() ?? []) {
      const parent = reference.getParent();
      if (
        Node.isSpreadAssignment(parent) &&
        parent.getExpression() === reference &&
        Node.isObjectLiteralExpression(parent.getParent()) &&
        checkedOptions.has(parent.getParentIfKindOrThrow(SyntaxKind.ObjectLiteralExpression))
      )
        continue;
      if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getExpression() === reference &&
        isMember(parent, ['DEFAULT_WIN_OPTS', 'webPreferences'])
      ) {
        const spread = parent.getParent();
        if (Node.isSpreadAssignment(spread) && spread.getExpression() === parent) continue;
      }
      violations.push(`DEFAULT_WIN_OPTS reference: ${parent.getText()}`);
    }
    return violations;
  } finally {
    windowProject.removeSourceFile(file);
  }
}

describe('main/index.ts wires BrowserWindow min-size at construction', () => {
  const validSource = `
    import { WINDOW_MIN_SIZE } from './window-min-size.ts';
    const DEFAULT_WIN_OPTS = { minWidth: WINDOW_MIN_SIZE.NAVIGATOR.width, minHeight: WINDOW_MIN_SIZE.NAVIGATOR.height };
    new WindowManager({ createWindow: (opts) => new BrowserWindow({ ...DEFAULT_WIN_OPTS, minWidth: WINDOW_MIN_SIZE.EDITOR.width, minHeight: WINDOW_MIN_SIZE.EDITOR.height }) });
    createNavigatorWindow({ createWindow: (opts) => new BrowserWindow({ ...DEFAULT_WIN_OPTS }) });
    createTerminalWindow({ createWindow: (opts) => new BrowserWindow({ ...DEFAULT_WIN_OPTS, minWidth: WINDOW_MIN_SIZE.EDITOR.width, minHeight: WINDOW_MIN_SIZE.EDITOR.height }) });
    openNoteWindow({ createWindow: (opts) => new BrowserWindow({ ...DEFAULT_WIN_OPTS, minWidth: WINDOW_MIN_SIZE.EDITOR.width, minHeight: WINDOW_MIN_SIZE.EDITOR.height }) });
    createSlidesWindow({ createWindow: (opts) => new BrowserWindow({ ...DEFAULT_WIN_OPTS, minWidth: WINDOW_MIN_SIZE.EDITOR.width, minHeight: WINDOW_MIN_SIZE.EDITOR.height }) });
    function createDesktopUninstallUtilityWindow(options) { return new BrowserWindow({ minWidth: options.minWidth, minHeight: options.minHeight }); }
  `;

  test('accepts exact members and rejects a platform-dependent minimum', () => {
    expect(windowMinSizeViolations(validSource)).toEqual([]);
    expect(
      windowMinSizeViolations(
        validSource.replace(
          'minWidth: WINDOW_MIN_SIZE.NAVIGATOR.width',
          "minWidth: process.platform === 'darwin' ? WINDOW_MIN_SIZE.NAVIGATOR.width : 320",
        ),
      ),
    ).toEqual(['DEFAULT_WIN_OPTS.minWidth']);
  });

  test('rejects an unaccounted constructor even with valid minima', () => {
    expect(
      windowMinSizeViolations(
        `${validSource}\nnew BrowserWindow({ minWidth: WINDOW_MIN_SIZE.NAVIGATOR.width, minHeight: WINDOW_MIN_SIZE.NAVIGATOR.height });`,
      ),
    ).toEqual(['unaccounted BrowserWindow: <unknown>']);
  });

  test.each(
    [...windowFactories].flatMap(([factory, member]) =>
      ['width', 'height'].map((dimension) => ({ factory, member, dimension })),
    ),
  )('rejects a wrong $dimension on $factory', ({ factory, member, dimension }) => {
    const key = dimension === 'width' ? 'minWidth' : 'minHeight';
    const changed = validSource
      .split('\n')
      .map((line) => {
        if (!line.includes(`${factory}({`)) return line;
        return member === 'NAVIGATOR'
          ? line.replace('...DEFAULT_WIN_OPTS', `...DEFAULT_WIN_OPTS, ${key}: 320`)
          : line.replace(`${key}: WINDOW_MIN_SIZE.${member}.${dimension}`, `${key}: 320`);
      })
      .join('\n');
    expect(windowMinSizeViolations(changed)).toEqual(
      member === 'NAVIGATOR'
        ? [`${factory}.minWidth`, `${factory}.minHeight`]
        : [`${factory}.${key}`],
    );
  });

  test.each([
    ["'minWidth': 320", 'minWidth'],
    ['"minHeight": 240', 'minHeight'],
    ["['minWidth']: 320", 'minWidth'],
    ['["minHeight"]: 240', 'minHeight'],
    ['minWidth', 'minWidth'],
    ['minHeight', 'minHeight'],
    ['get minWidth() { return 320; }', 'minWidth'],
  ])('rejects a Navigator override %s', (override) => {
    const anchor = 'new BrowserWindow({ ...DEFAULT_WIN_OPTS })';
    expect(
      windowMinSizeViolations(
        validSource.replace(anchor, `new BrowserWindow({ ...DEFAULT_WIN_OPTS, ${override} })`),
      ),
    ).toEqual(['createNavigatorWindow.minWidth', 'createNavigatorWindow.minHeight']);
  });

  test('accepts equivalent quoted and computed constant option names', () => {
    expect(
      windowMinSizeViolations(
        validSource.replace('minWidth:', "'minWidth':").replace('minHeight:', "['minHeight']:"),
      ),
    ).toEqual([]);
  });

  test.each([
    '...override',
    '...chrome()',
    '...(platform ? left : right)',
    '...{ ...{ minWidth: 1 } }',
  ])('requires minima after every opaque spread %s', (spread) => {
    const minimum =
      'minWidth: WINDOW_MIN_SIZE.NAVIGATOR.width, minHeight: WINDOW_MIN_SIZE.NAVIGATOR.height';
    expect(windowMinSizeViolations(validSource.replace(minimum, `${spread}, ${minimum}`))).toEqual(
      [],
    );
    expect(windowMinSizeViolations(validSource.replace(minimum, `${minimum}, ${spread}`))).toEqual([
      'DEFAULT_WIN_OPTS spread after minWidth',
      'DEFAULT_WIN_OPTS spread after minHeight',
    ]);
    const utility = 'minWidth: options.minWidth, minHeight: options.minHeight';
    expect(windowMinSizeViolations(validSource.replace(utility, `${spread}, ${utility}`))).toEqual(
      [],
    );
    expect(windowMinSizeViolations(validSource.replace(utility, `${utility}, ${spread}`))).toEqual([
      'createDesktopUninstallUtilityWindow spread after minWidth',
      'createDesktopUninstallUtilityWindow spread after minHeight',
    ]);
  });
  test.each(['minWidth', "'minWidth'", "['minWidth']"])(
    'counts duplicate utility properties %s',
    (key) => {
      expect(windowMinSizeViolations(validSource)).toEqual([]);
      expect(
        windowMinSizeViolations(
          validSource.replace(
            'minHeight: options.minHeight',
            `minHeight: options.minHeight, ${key}: 1`,
          ),
        ),
      ).toEqual(['createDesktopUninstallUtilityWindow.minWidth']);
    },
  );
  test.each([
    'DEFAULT_WIN_OPTS.minWidth = 1;',
    'Object.assign(DEFAULT_WIN_OPTS, { minWidth: 1 });',
    'const alias = DEFAULT_WIN_OPTS;',
    'const elsewhere = { ...DEFAULT_WIN_OPTS };',
    'void DEFAULT_WIN_OPTS.webPreferences;',
  ])('refuses the defaults reference %s', (statement) => {
    expect(windowMinSizeViolations(validSource)).toEqual([]);
    expect(
      windowMinSizeViolations(`${validSource} ${statement}`).filter((value) =>
        value.startsWith('DEFAULT_WIN_OPTS reference:'),
      ),
    ).toHaveLength(1);
  });
  test.each([
    'function f() { const DEFAULT_WIN_OPTS = {}; }',
    'function f(DEFAULT_WIN_OPTS) {}',
    'function DEFAULT_WIN_OPTS() {}',
    'class DEFAULT_WIN_OPTS {}',
  ])('refuses extra defaults binding %s', (statement) => {
    expect(windowMinSizeViolations(validSource)).toEqual([]);
    expect(
      windowMinSizeViolations(`${validSource} ${statement}`).filter(
        (value) => value === 'DEFAULT_WIN_OPTS declaration census',
      ),
    ).toHaveLength(1);
  });
  test.each([
    'const WINDOW_MIN_SIZE = {};',
    'function f(WINDOW_MIN_SIZE) {}',
    'function WINDOW_MIN_SIZE() {}',
    'class WINDOW_MIN_SIZE {}',
  ])('requires the sole WINDOW_MIN_SIZE import binding: %s', (statement) => {
    expect(windowMinSizeViolations(validSource)).toEqual([]);
    expect(windowMinSizeViolations(`${validSource} function scope() { ${statement} }`)).toEqual([
      'WINDOW_MIN_SIZE binding census',
    ]);
  });
  test('requires module-level const defaults and valid syntax', () => {
    expect(windowMinSizeViolations(validSource)).toEqual([]);
    expect(
      windowMinSizeViolations(
        validSource.replace('const DEFAULT_WIN_OPTS', 'let DEFAULT_WIN_OPTS'),
      ),
    ).toContain('DEFAULT_WIN_OPTS declaration census');
    expect(
      windowMinSizeViolations(
        validSource
          .replace('const DEFAULT_WIN_OPTS', 'function scope() { const DEFAULT_WIN_OPTS')
          .replace(';\n    new WindowManager', '; }\n    new WindowManager'),
      ),
    ).toContain('DEFAULT_WIN_OPTS declaration census');
    expect(
      windowMinSizeViolations(`${validSource} const broken = ;`).filter((value) =>
        value.startsWith('syntax:'),
      ),
    ).toHaveLength(1);
  });

  test('all constructors use their unconditional width and height members', () => {
    expect(windowMinSizeViolations(readFileSync(join(__dirname, 'index.ts'), 'utf-8'))).toEqual([]);
  });
});
