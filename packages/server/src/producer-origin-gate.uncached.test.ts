import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..');
const SCAN_ROOTS = [
  join(packagesDir, 'app', 'src'),
  join(packagesDir, 'server', 'src'),
  join(packagesDir, 'core', 'src'),
];

const BODY_WRITE_PRIMITIVES = new Set<string>([
  'composeAndWriteRawBody',
  'replaceRawBody',
  'deriveFragmentFromYtext',
  'applyAgentMarkdownWrite',
  'applyDiskContentToDoc',
  'applyDiskContent',
  'updateYFragment',
  'applyFastDiff',
]);

const MUTATION_METHODS = new Set<string>(['insert', 'delete', 'applyDelta', 'format', 'push']);

const ORIGIN_FORWARDING_FNS = new Set<string>(['chunkedYTextInsert']);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

function calleeName(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (callee.isKind(SyntaxKind.Identifier)) return callee.getText();
  if (callee.isKind(SyntaxKind.PropertyAccessExpression)) return callee.getName();
  return null;
}

function isSourceTextAccessor(expr: Node): boolean {
  if (!Node.isCallExpression(expr)) return false;
  const callee = expr.getExpression();
  if (!callee.isKind(SyntaxKind.PropertyAccessExpression) || callee.getName() !== 'getText')
    return false;
  const arg = expr.getArguments()[0];
  return arg?.isKind(SyntaxKind.StringLiteral) === true && arg.getLiteralText() === 'source';
}

function isFragmentAccessor(expr: Node): boolean {
  if (!Node.isCallExpression(expr)) return false;
  const callee = expr.getExpression();
  if (!callee.isKind(SyntaxKind.PropertyAccessExpression)) return false;
  if (callee.getName() === 'getXmlFragment') return true;
  if (callee.getName() === 'get') {
    const arg = expr.getArguments()[0];
    return arg?.isKind(SyntaxKind.StringLiteral) === true && arg.getLiteralText() === 'default';
  }
  return false;
}

function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      a.isKind(SyntaxKind.ArrowFunction) ||
      a.isKind(SyntaxKind.FunctionExpression) ||
      a.isKind(SyntaxKind.FunctionDeclaration) ||
      a.isKind(SyntaxKind.MethodDeclaration),
  );
}

function bodyHandleNames(scope: Node): Set<string> {
  const names = new Set<string>();
  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (init && (isSourceTextAccessor(init) || isFragmentAccessor(init))) {
      const nameNode = decl.getNameNode();
      if (nameNode.isKind(SyntaxKind.Identifier)) names.add(nameNode.getText());
    }
  }
  return names;
}

function bodyMutatesDocument(body: Node, handleNames: Set<string>): boolean {
  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    const name = calleeName(node);
    if (name && BODY_WRITE_PRIMITIVES.has(name)) {
      found = true;
      return;
    }
    if (
      callee.isKind(SyntaxKind.PropertyAccessExpression) &&
      MUTATION_METHODS.has(callee.getName())
    ) {
      const recv = callee.getExpression();
      if (recv.isKind(SyntaxKind.Identifier) && handleNames.has(recv.getText())) found = true;
      else if (isSourceTextAccessor(recv) || isFragmentAccessor(recv)) found = true;
    }
  });
  return found;
}

function isNamedFrozenOrigin(originArg: Node | undefined): boolean {
  if (!originArg) return false;
  if (originArg.isKind(SyntaxKind.Identifier)) return originArg.getText() !== 'undefined';
  if (originArg.isKind(SyntaxKind.PropertyAccessExpression)) return true;
  return false;
}

function transactCallbackAndOrigin(call: Node): { body: Node; origin: Node | undefined } | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  const cbIndex = args.findIndex(
    (a) => a.isKind(SyntaxKind.ArrowFunction) || a.isKind(SyntaxKind.FunctionExpression),
  );
  if (cbIndex === -1) return null;
  const cb = args[cbIndex];
  const body = Node.isArrowFunction(cb) || Node.isFunctionExpression(cb) ? cb.getBody() : undefined;
  if (!body) return null;
  return { body, origin: args[cbIndex + 1] };
}

function chunkedInsertOriginArg(call: Node): Node | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const options = call.getArguments()[4];
  if (!options?.isKind(SyntaxKind.ObjectLiteralExpression)) return undefined;
  const prop = options.getProperty('origin');
  if (prop?.isKind(SyntaxKind.PropertyAssignment)) return prop.getInitializer();
  if (prop?.isKind(SyntaxKind.ShorthandPropertyAssignment)) return prop.getNameNode();
  return undefined;
}

function analyzeSourceFile(rel: string, sf: SourceFile): Violation[] {
  const violations: Violation[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call);

    if (name && ORIGIN_FORWARDING_FNS.has(name)) {
      const originArg = chunkedInsertOriginArg(call);
      if (!isNamedFrozenOrigin(originArg)) {
        violations.push({
          file: rel,
          line: call.getStartLineNumber(),
          detail: `${name}(...) omits a named frozen \`origin\` option`,
        });
      }
      continue;
    }

    const callee = call.getExpression();
    if (!callee.isKind(SyntaxKind.PropertyAccessExpression) || callee.getName() !== 'transact')
      continue;
    const parts = transactCallbackAndOrigin(call);
    if (!parts) continue;
    const scope = enclosingFunction(call) ?? sf;
    const handleNames = bodyHandleNames(scope);
    if (!bodyMutatesDocument(parts.body, handleNames)) continue;
    if (!isNamedFrozenOrigin(parts.origin)) {
      violations.push({
        file: rel,
        line: call.getStartLineNumber(),
        detail: 'body-content transact() without a named frozen origin',
      });
    }
  }
  return violations;
}

function isScannableFile(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name.includes('.test-helper.')) return false;
  if (/\.(test|spec|e2e)\./.test(name)) return false;
  return true;
}

function collectCandidateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__mocks__') continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (isScannableFile(entry)) {
        const text = readFileSync(abs, 'utf8');
        if (text.includes('.transact(') || text.includes('chunkedYTextInsert(')) out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

function newProject(): Project {
  return new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true, allowJs: false },
  });
}

describe('producer origin gate', () => {
  it('every body-content transaction carries a named frozen origin', () => {
    const project = newProject();
    const files: Array<readonly [string, SourceFile]> = [];
    for (const root of SCAN_ROOTS) {
      for (const abs of collectCandidateFiles(root)) {
        const rel = abs.slice(packagesDir.length + 1);
        files.push([rel, project.addSourceFileAtPath(abs)] as const);
      }
    }
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(([rel, sf]) => analyzeSourceFile(rel, sf));
    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}:${v.line} — ${v.detail}`).join('\n');
      throw new Error(
        `Found ${violations.length} content transaction(s) without a named frozen origin:\n${lines}\n` +
          `Give the write a named frozen origin constant (e.g. LINT_FIX_ORIGIN, session.origin).`,
      );
    }
  });

  it('catches a bare body-content transact (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-bare-transact.ts',
      `function paste(provider: any, doc: any) {
         const ytext = provider.document.getText('source');
         doc.transact(() => {
           ytext.insert(0, 'x');
         });
       }`,
    );
    const violations = analyzeSourceFile('planted-bare-transact.ts', sf);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('named frozen origin');
  });

  it('catches an undefined / inline-literal origin (planted positives)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-bad-origin.ts',
      `function w(provider: any, doc: any) {
         const ytext = provider.document.getText('source');
         doc.transact(() => { ytext.delete(0, 1); }, undefined);
         doc.transact(() => { ytext.delete(0, 1); }, { source: 'local' });
         doc.transact(() => { ytext.delete(0, 1); }, null);
       }`,
    );
    expect(analyzeSourceFile('planted-bad-origin.ts', sf)).toHaveLength(3);
  });

  it('catches a chunkedYTextInsert call missing a named origin (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-chunked.ts',
      `function paste(doc: any, ytext: any) {
         chunkedYTextInsert(doc, ytext, 0, 'big', { resolveOffset: (n: number) => n });
       }`,
    );
    const violations = analyzeSourceFile('planted-chunked.ts', sf);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('chunkedYTextInsert');
  });

  it('passes a named-origin body transact and a config-doc (variable-key) write (positive controls)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'controls.ts',
      `const LINT_FIX_ORIGIN = Object.freeze({ context: { origin: 'lint-fix' } });
       function good(provider: any, doc: any) {
         const ytext = provider.document.getText('source');
         doc.transact(() => { ytext.insert(0, 'x'); }, LINT_FIX_ORIGIN);
       }
       function configDoc(ydoc: any, ytextKey: string) {
         const ytext = ydoc.getText(ytextKey);
         ydoc.transact(() => { ytext.insert(0, 'cfg'); });
       }
       function primitive(session: any) {
         session.dc.document.transact(() => {
           replaceRawBody(session, 'body');
         }, session.origin);
       }
       function chunked(doc: any, ytext: any) {
         chunkedYTextInsert(doc, ytext, 0, 'big', { origin: SOURCE_PASTE_ORIGIN });
       }`,
    );
    expect(analyzeSourceFile('controls.ts', sf)).toHaveLength(0);
  });
});
