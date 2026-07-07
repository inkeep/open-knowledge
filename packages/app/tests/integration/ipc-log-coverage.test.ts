/**
 * IPC log coverage meta-test.
 *
 * Pins the structured-logging discipline for IPC failure paths: every
 * `return { ok: false, ... }` (or `return { ok: false, error: ... }`) in
 * the desktop main-process source MUST be preceded by a `logIpcError(...)`
 * call within `IPC_LOG_ADJACENCY_MAX_STATEMENTS` statements above (in the
 * same surrounding block). Mirrors the HTTP `errorResponse(...)` discipline
 * established for HTTP errors — same architectural pattern, applied to the
 * IPC transport.
 *
 * Failure mode: developer adds a new IPC handler with a `return { ok: false }`
 * shape and forgets the `logIpcError(...)` call, silently re-introducing
 * the Pino observability asymmetry that operators triaging desktop incidents
 * would notice (HTTP errors hit Pino; IPC errors don't). This test fails
 * the build at PR time with a precise file:line message + the reason value.
 *
 * What this test does NOT gate: utility-module returns nested several call
 * sites away from the IPC channel boundary. The wrapping happens at the
 * boundary (registration in `main/index.ts`, `consent-dialog.ts`,
 * `mcp-wiring.ts`), where the discriminated `{ ok: false }` result is
 * about to be returned to the renderer. A utility helper that returns
 * `{ ok: false; reason }` to its caller (e.g., `asset-allowlist.ts`'s
 * `openAssetSafely`) is logged when the caller (e.g., the
 * `ok:shell:open-asset` handler in `main/index.ts`) routes the result
 * back over IPC — not at every internal helper site.
 *
 * Scope detection: the test only audits files that contain at least one
 * `handle('ok:...', ...)` or `register('ok:...', ...)` call, since those
 * are the channel-registration boundaries. Utility modules without any
 * registration are out of scope by construction — their returns flow up
 * to a boundary handler that owns the structured-log emission.
 */

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

/**
 * Maximum number of preceding sibling statements scanned for a paired
 * `logIpcError(...)` call when a `return { ok: false, ... }` is encountered.
 * Set to 5 because most handlers have 1-2 setup/log statements + the
 * return; 5 leaves headroom for guard + counter + log + return without
 * forcing the meta-test to cross-block.
 *
 * Increasing this constant weakens the locality guarantee that makes
 * the meta-test useful.
 *
 * The constant is exported so future changes are visible to the meta-test
 * itself (a bump from 5 to 10 should never sail past unnoticed).
 */
export const IPC_LOG_ADJACENCY_MAX_STATEMENTS = 5;

function isExcludedPath(absPath: string): boolean {
  if (absPath.endsWith('.d.ts')) return true;
  if (/\.test\.tsx?$/.test(absPath)) return true;
  if (absPath.includes('/node_modules/')) return true;
  if (absPath.includes('/dist/')) return true;
  // ipc-log.ts itself defines logIpcError — exempt.
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

/**
 * Strip away `as <T>`, `<T>` (legacy), `satisfies <T>`, and parentheses
 * wrappers to reach the underlying value expression. Without this, the
 * meta-test silently misses `return { ok: false, reason: 'x' } as const`
 * (an `AsExpression` wrapping the object literal), which is the shape
 * `index.ts` uses for path-escape returns. We intentionally do
 * NOT match the type declaration `{ ok: false; reason: 'a' | 'b' }`
 * because that's a type, not a runtime expression — but `as const` IS a
 * runtime expression and must be audited.
 */
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

/**
 * True when the object literal's `ok` property is the false literal — the
 * shape the meta-test gates. Unwraps `as const` and similar value-level
 * type assertions before checking, so that
 * `return { ok: false, reason: 'x' } as const` is correctly recognized
 * as a fail-return shape.
 */
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

/** Extract the reason/error expression text from an `{ ok: false; reason: <expr> }` literal for reporting. */
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

/**
 * Walk up the surrounding block looking for a sibling `logIpcError(...)` call
 * within `IPC_LOG_ADJACENCY_MAX_STATEMENTS` statements above the return.
 * Searches the immediate enclosing Block / SourceFile statement list — does
 * NOT cross into a parent function/method body.
 */
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

/**
 * True when the call expression is a channel registration of the form
 * `handle('ok:...', <fn>)` or `register('ok:...', <fn>)`. Both `handle` and
 * `register` are synonyms for `ipcMain.handle` in this codebase (`handle`
 * comes from the typed `createHandler` factory; `register` is a local
 * helper consent-dialog.ts and mcp-wiring.ts both use). The first argument
 * is the channel name literal.
 */
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

/**
 * Collect the channel-handler bodies in a source file — the second argument
 * of each `handle('ok:...', <fn>)` or `register('ok:...', <fn>)` call. The
 * meta-test only audits `return { ok: false }` statements found INSIDE
 * these bodies, since those are the only returns that flow back to the
 * renderer as an IPC failure result. Returns inside helper functions
 * (e.g., `validateConfirmRequest`) that are merely consumed by handlers
 * are out of scope — the handler logs the failure when consuming the helper's
 * result.
 */
function collectHandlerBodies(sf: SourceFile): Node[] {
  const bodies: Node[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isChannelRegistrationCall(call)) continue;
    const args = call.getArguments();
    const handler = args[1];
    if (!handler) continue;
    // Handler is typically an inline arrow / function expression. It can
    // also be a direct identifier reference to a hoisted handler (e.g.,
    // `register('ok:mcp-wiring:confirm', confirmHandler)` in mcp-wiring.ts).
    // For inline forms, capture the body node. For identifier references,
    // resolve the declaration in the same source file by scanning for a
    // matching `const <name> = async (...) => { ... }` or
    // `async function <name>() { ... }` declaration.
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

/**
 * Resolve a handler identifier (e.g., `confirmHandler`) to its declaration
 * body. Handles `const X = async (...) => { ... }`, `const X = function(...) { ... }`,
 * and `async function X(...) { ... }` shapes.
 */
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

/**
 * Files in scope are those that bind at least one IPC channel via
 * `handle('ok:...', ...)` (the typed channel registrar from
 * `../shared/ipc-handler.ts`) or via `register('ok:...', ...)` (the local
 * helper consent-dialog.ts/mcp-wiring.ts use that wraps `ipcMain.handle`).
 * Utility modules without channel bindings are out of scope — their
 * `{ ok: false }` returns are logged at the channel boundary in the file
 * that registers the handler.
 */
const CHANNEL_REGISTRATION_RE = /\b(?:handle|register)\(\s*['"]ok:[^'"]+['"]/;

function isChannelRegistrationFile(content: string): boolean {
  return CHANNEL_REGISTRATION_RE.test(content);
}

// Anti-vacuousness floor for the scan. The desktop main-process tree
// contains a small but stable set of channel-registration files (currently
// at least `index.ts`, `consent-dialog.ts`, `mcp-wiring.ts`). A count below
// this threshold means `MAIN_ROOT` is wrong (path typo, directory rename),
// the glob regressed, or the channel-registration regex regressed —
// without this floor, `enumerateMainSourceFiles` over an invalid root
// silently yields zero files and the violations array stays empty.
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
      // Skip files that don't even mention `ok: false` — fast filter.
      if (!/ok:\s*false/.test(content)) continue;
      // Skip files that don't bind any IPC channels — those are utility
      // modules whose returns flow up to a boundary handler in another file.
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
