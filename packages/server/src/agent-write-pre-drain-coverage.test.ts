import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SPINE_FILES = [join(here, 'api-extension.ts'), join(here, 'acp', 'thread-manager.ts')];

const FULL_BODY_OVERWRITE = new Set(['replace', 'patch']);

function newProject(): Project {
  return new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true, allowJs: false },
  });
}

function calleeName(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return null;
}

function positionLiterals(call: Node): Set<string> {
  const out = new Set<string>();
  if (!Node.isCallExpression(call)) return out;
  const arg = call.getArguments()[2];
  if (!arg) return out;
  for (const lit of [
    ...(Node.isStringLiteral(arg) ? [arg] : []),
    ...arg.getDescendantsOfKind(SyntaxKind.StringLiteral),
  ]) {
    out.add(lit.getLiteralText());
  }
  return out;
}

function isFunctionLike(n: Node): boolean {
  return (
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n)
  );
}

function handlerScope(call: Node): Node | undefined {
  for (const anc of call.getAncestors()) {
    if (!isFunctionLike(anc)) continue;
    const parent = anc.getParent();
    if (parent && Node.isCallExpression(parent) && calleeName(parent) === 'transact') continue;
    return anc;
  }
  return undefined;
}

describe('agent-write pre-drain coverage', () => {
  it('every pre-drainable applyAgentMarkdownWrite spine call is preceded by agentWritePreDrain', () => {
    const project = newProject();
    const spineCalls = SPINE_FILES.flatMap((path) =>
      project
        .addSourceFileAtPath(path)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => calleeName(c) === 'applyAgentMarkdownWrite'),
    );
    expect(spineCalls.length).toBeGreaterThanOrEqual(6);

    const preDrainable = spineCalls.filter((call) => {
      const positions = positionLiterals(call);
      return positions.size === 0 || [...positions].some((p) => !FULL_BODY_OVERWRITE.has(p));
    });
    expect(preDrainable.length).toBeGreaterThanOrEqual(3);

    const missing = preDrainable
      .filter((call) => {
        const scope = handlerScope(call);
        if (!scope) return true;
        return !scope
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .some((c) => calleeName(c) === 'agentWritePreDrain' && c.getStart() < call.getStart());
      })
      .map((c) => `${basename(c.getSourceFile().getFilePath())}:${c.getStartLineNumber()}`);
    expect(missing).toEqual([]);
  });

  it('does not exempt a site that writes at a pre-drainable position (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-append-without-pre-drain.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown) {
         applyAgentMarkdownWrite(doc, 'x', 'append');
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    const positions = call ? positionLiterals(call) : new Set<string>();
    expect([...positions]).toEqual(['append']);
    expect([...positions].some((p) => !FULL_BODY_OVERWRITE.has(p))).toBe(true);
  });

  it('exempts a site that only ever writes a full-body overwrite (negative control)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-patch-only.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown) {
         applyAgentMarkdownWrite(doc, 'x', 'patch');
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    const positions = call ? positionLiterals(call) : new Set<string>();
    expect([...positions].some((p) => !FULL_BODY_OVERWRITE.has(p))).toBe(false);
  });

  it('refuses to exempt an unanalysable position (fail-closed)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-dynamic-position.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown, pos: string) {
         applyAgentMarkdownWrite(doc, 'x', pos);
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call ? positionLiterals(call).size : -1).toBe(0);
  });
});
