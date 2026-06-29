import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Glob } from 'bun';
import {
  type Expression,
  type Node,
  Project,
  type ReturnStatement,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const MAIN_ROOT = join(REPO_ROOT, 'packages/desktop/src/main');

export const IPC_LOG_ADJACENCY_MAX_STATEMENTS = 5;

function isExcludedPath(absPath: string): boolean {
  if (absPath.endsWith('.d.ts')) return true;
  if (/\.test\.tsx?$/.test(absPath)) return true;
  if (absPath.includes('/node_modules/')) return true;
  if (absPath.includes('/dist/')) return true;
  if (absPath.endsWith('/ipc-log.ts')) return true;
  return false;
}

function* enumerateMainSourceFiles(): Generator<string> {
  const glob = new Glob('**/*.ts');
  for (const rel of glob.scanSync({ cwd: MAIN_ROOT })) {
    const abs = join(MAIN_ROOT, rel);
    if (isExcludedPath(abs)) continue;
    yield abs;
  }
}

function makeProject(): Project {
  return new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      noLib: true,
      allowJs: false,
    },
  });
}

interface FailReturn {
  readonly file: string;
  readonly line: number;
  readonly reasonExpr: string;
}

function unwrapValueExpression(expr: Expression): Expression {
  let cur: Expression = expr;
  while (
    cur.isKind(SyntaxKind.AsExpression) ||
    cur.isKind(SyntaxKind.TypeAssertionExpression) ||
    cur.isKind(SyntaxKind.SatisfiesExpression) ||
    cur.isKind(SyntaxKind.ParenthesizedExpression)
  ) {
    cur = cur.getExpression();
  }
  return cur;
}

function isOkFalseObjectLiteral(expr: Expression): boolean {
  const unwrapped = unwrapValueExpression(expr);
  if (!unwrapped.isKind(SyntaxKind.ObjectLiteralExpression)) return false;
  for (const prop of unwrapped.getProperties()) {
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const nameNode = prop.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier)) continue;
    if (nameNode.getText() !== 'ok') continue;
    const initializer = prop.getInitializer();
    if (initializer?.isKind(SyntaxKind.FalseKeyword)) return true;
  }
  return false;
}

function extractReasonExpr(expr: Expression): string {
  const unwrapped = unwrapValueExpression(expr);
  if (!unwrapped.isKind(SyntaxKind.ObjectLiteralExpression)) return '<unknown>';
  for (const prop of unwrapped.getProperties()) {
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const nameNode = prop.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier)) continue;
    const name = nameNode.getText();
    if (name !== 'reason' && name !== 'error') continue;
    const initializer = prop.getInitializer();
    if (initializer) return initializer.getText();
  }
  return '<no-reason>';
}

function findPrecedingLogCall(returnStmt: ReturnStatement, block: Node): boolean {
  const statements = blockStatements(block);
  if (statements === null) return false;
  const returnIndex = statements.indexOf(returnStmt as unknown as Node);
  if (returnIndex < 0) return false;
  const start = Math.max(0, returnIndex - IPC_LOG_ADJACENCY_MAX_STATEMENTS);
  for (let i = returnIndex - 1; i >= start; i--) {
    const stmt = statements[i];
    if (stmt && statementContainsLogIpcError(stmt)) return true;
  }
  return false;
}

function blockStatements(node: Node): readonly Node[] | null {
  if (node.isKind(SyntaxKind.Block)) return node.getStatements();
  if (node.isKind(SyntaxKind.SourceFile)) return node.getStatements();
  return null;
}

function statementContainsLogIpcError(stmt: Node): boolean {
  let found = false;
  stmt.forEachDescendant((node, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (!node.isKind(SyntaxKind.CallExpression)) return;
    const callee = node.getExpression();
    if (callee.isKind(SyntaxKind.Identifier) && callee.getText() === 'logIpcError') {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

function findEnclosingBlock(node: Node): Node | null {
  let cur: Node | undefined = node.getParent();
  while (cur !== undefined) {
    if (cur.isKind(SyntaxKind.Block) || cur.isKind(SyntaxKind.SourceFile)) return cur;
    cur = cur.getParent();
  }
  return null;
}

function isChannelRegistrationCall(node: Node): boolean {
  if (!node.isKind(SyntaxKind.CallExpression)) return false;
  const callee = node.getExpression();
  if (!callee.isKind(SyntaxKind.Identifier)) return false;
  const calleeName = callee.getText();
  if (calleeName !== 'handle' && calleeName !== 'register') return false;
  const args = node.getArguments();
  if (args.length < 2) return false;
  const firstArg = args[0];
  if (!firstArg) return false;
  if (
    !firstArg.isKind(SyntaxKind.StringLiteral) &&
    !firstArg.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
  ) {
    return false;
  }
  return firstArg.getLiteralText().startsWith('ok:');
}

function collectHandlerBodies(sf: SourceFile): Node[] {
  const bodies: Node[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isChannelRegistrationCall(call)) continue;
    const args = call.getArguments();
    const handler = args[1];
    if (!handler) continue;
    if (
      handler.isKind(SyntaxKind.ArrowFunction) ||
      handler.isKind(SyntaxKind.FunctionExpression) ||
      handler.isKind(SyntaxKind.FunctionDeclaration)
    ) {
      const body = handler.getBody();
      if (body !== undefined) bodies.push(body);
    } else if (handler.isKind(SyntaxKind.Identifier)) {
      const declBody = findHandlerDeclarationBody(sf, handler.getText());
      if (declBody !== null) bodies.push(declBody);
    }
  }
  return bodies;
}

function findHandlerDeclarationBody(sf: SourceFile, name: string): Node | null {
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const declName = decl.getNameNode();
    if (!declName.isKind(SyntaxKind.Identifier)) continue;
    if (declName.getText() !== name) continue;
    const init = decl.getInitializer();
    if (
      init &&
      (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression))
    ) {
      const body = init.getBody();
      if (body !== undefined) return body;
    }
  }
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (fn.getName() !== name) continue;
    const body = fn.getBody();
    if (body !== undefined) return body;
  }
  return null;
}

function collectUnpairedFailReturns(absPath: string, project: Project): FailReturn[] {
  const sf = project.addSourceFileAtPath(absPath);
  const out: FailReturn[] = [];
  const handlerBodies = collectHandlerBodies(sf);
  if (handlerBodies.length === 0) {
    project.removeSourceFile(sf);
    return out;
  }

  for (const body of handlerBodies) {
    for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const retExpr = ret.getExpression();
      if (retExpr === undefined) continue;
      if (!isOkFalseObjectLiteral(retExpr)) continue;
      const block = findEnclosingBlock(ret);
      const hasLog = block !== null && findPrecedingLogCall(ret, block);
      if (!hasLog) {
        out.push({
          file: relative(REPO_ROOT, absPath),
          line: ret.getStartLineNumber(),
          reasonExpr: extractReasonExpr(retExpr),
        });
      }
    }
  }
  project.removeSourceFile(sf);
  return out;
}

const CHANNEL_REGISTRATION_RE = /\b(?:handle|register)\(\s*['"]ok:[^'"]+['"]/;

function isChannelRegistrationFile(content: string): boolean {
  return CHANNEL_REGISTRATION_RE.test(content);
}

const MIN_CHANNEL_REGISTRATION_FILES = 3;

describe('IPC log coverage', () => {
  test('scan covers ≥ MIN_CHANNEL_REGISTRATION_FILES channel-registration files (anti-vacuousness)', () => {
    let count = 0;
    for (const file of enumerateMainSourceFiles()) {
      const content = readFileSync(file, 'utf8');
      if (isChannelRegistrationFile(content)) count++;
    }
    expect(count).toBeGreaterThanOrEqual(MIN_CHANNEL_REGISTRATION_FILES);
  });

  test('every `return { ok: false, ... }` in main-process channel-registration files is paired with a logIpcError call', () => {
    const violations: FailReturn[] = [];
    const project = makeProject();
    for (const file of enumerateMainSourceFiles()) {
      const content = readFileSync(file, 'utf8');
      if (!/ok:\s*false/.test(content)) continue;
      if (!isChannelRegistrationFile(content)) continue;
      violations.push(...collectUnpairedFailReturns(file, project));
    }
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — return { ok: false, reason: ${v.reasonExpr} }`)
        .join('\n');
      throw new Error(
        `IPC failure return is not paired with logIpcError(...).\n` +
          `Every \`return { ok: false, ... }\` in packages/desktop/src/main/**/*.ts must be preceded by\n` +
          `a \`logIpcError({ event: 'ipc.error', channel, reason, handler, cause? })\` call within\n` +
          `IPC_LOG_ADJACENCY_MAX_STATEMENTS (= ${IPC_LOG_ADJACENCY_MAX_STATEMENTS}) statements above,\n` +
          `in the same surrounding block. This pins the IPC observability asymmetry that the HTTP-side\n` +
          `errorResponse() discipline closed.\n` +
          `Violations:\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
