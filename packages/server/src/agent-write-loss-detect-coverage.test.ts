import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SPINE_FILES = [join(here, 'api-extension.ts'), join(here, 'acp', 'thread-manager.ts')];

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

function threadsLossDetect(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  return call
    .getArguments()
    .some((arg) => Node.isCallExpression(arg) && calleeName(arg) === 'agentWriteLossDetect');
}

describe('agent-write loss-detect coverage', () => {
  it('every applyAgentMarkdownWrite spine call threads agentWriteLossDetect', () => {
    const project = newProject();
    const spineCalls = SPINE_FILES.flatMap((path) =>
      project
        .addSourceFileAtPath(path)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => calleeName(c) === 'applyAgentMarkdownWrite'),
    );
    expect(spineCalls.length).toBeGreaterThanOrEqual(6);
    const missing = spineCalls
      .filter((c) => !threadsLossDetect(c))
      .map((c) => `${basename(c.getSourceFile().getFilePath())}:${c.getStartLineNumber()}`);
    expect(missing).toEqual([]);
  });

  it('flags a spine call that omits the loss detector (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-missing-loss-detect.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(session: { dc: { document: unknown } }) {
         applyAgentMarkdownWrite(session.dc.document, 'x', 'append');
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call && threadsLossDetect(call)).toBe(false);
  });

  it('recognizes a spine call that threads the loss detector (positive control)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-with-loss-detect.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       declare function agentWriteLossDetect(s: unknown): unknown;
       function h(session: { dc: { document: unknown } }) {
         applyAgentMarkdownWrite(
           session.dc.document,
           'x',
           'append',
           undefined,
           undefined,
           agentWriteLossDetect(session),
         );
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call && threadsLossDetect(call)).toBe(true);
  });
});
