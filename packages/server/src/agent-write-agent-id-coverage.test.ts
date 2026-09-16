import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { listAgentWriteSpineFiles } from './agent-write-spine-files.test-helper.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

function threadsWriterIdentity(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  return call
    .getArguments()
    .some((arg) => Node.isIdentifier(arg) && arg.getText() === 'suppliedWriterId');
}

describe('agent-write writer-identity coverage', () => {
  it('every applyAgentMarkdownWrite spine call threads its writer identity', () => {
    const project = newProject();
    const spineFiles = listAgentWriteSpineFiles(here);
    expect(spineFiles.length).toBeGreaterThan(0);
    const spineCalls = spineFiles.flatMap((path) =>
      project
        .addSourceFileAtPath(join(here, path))
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => calleeName(c) === 'applyAgentMarkdownWrite'),
    );
    expect(spineCalls.length).toBeGreaterThanOrEqual(6);
    const missing = spineCalls
      .filter((c) => !threadsWriterIdentity(c))
      .map((c) => `${basename(c.getSourceFile().getFilePath())}:${c.getStartLineNumber()}`);
    expect(missing).toEqual([]);
  });

  it('flags a spine call that omits the writer identity (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-missing-agent-id.ts',
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
    expect(call && threadsWriterIdentity(call)).toBe(false);
  });

  it('flags a spine call that threads the defaulted attribution id (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-with-agent-id.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       declare function agentWriteLossDetect(s: unknown): unknown;
       function h(session: { dc: { document: unknown }; agentId: string }) {
         applyAgentMarkdownWrite(
           session.dc.document,
           'x',
           'append',
           undefined,
           undefined,
           agentWriteLossDetect(session),
           session.agentId,
         );
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call && threadsWriterIdentity(call)).toBe(false);
  });

  it('flags a spine call that threads the loss-detect writerId (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-with-loss-detect-writer-id.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       declare function agentWriteLossDetect(s: unknown): { writerId: string | null };
       function h(session: { dc: { document: unknown } }) {
         const lossDetect = agentWriteLossDetect(session);
         const { writerId } = lossDetect;
         applyAgentMarkdownWrite(
           session.dc.document,
           'x',
           'append',
           undefined,
           undefined,
           lossDetect,
           writerId,
         );
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call && threadsWriterIdentity(call)).toBe(false);
  });

  it('recognizes the presence-bearing suppliedWriterId form (positive control)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-with-supplied-writer-id.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       declare function agentWriteLossDetect(s: unknown): unknown;
       function h(session: { dc: { document: unknown } }, suppliedWriterId: string | undefined) {
         applyAgentMarkdownWrite(
           session.dc.document,
           'x',
           'append',
           undefined,
           undefined,
           agentWriteLossDetect(session),
           suppliedWriterId,
         );
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    expect(call && threadsWriterIdentity(call)).toBe(true);
  });
});
