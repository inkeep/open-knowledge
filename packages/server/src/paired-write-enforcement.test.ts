import { beforeAll, describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { Glob } from 'bun';
import {
  type CallExpression,
  type Expression,
  type Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';


const SANCTIONED_PRIMITIVES = new Set<string>([
  'composeAndWriteRawBody',
  'replaceRawBody',
  'deriveFragmentFromYtext',
]);

const TRANSITIVE_PRIMITIVE_CALLERS = new Set<string>([
  'applyDiskContentToDoc',
  'applyDiskContent',
  'applyAgentMarkdownWrite',
]);

const SANCTIONED_NON_PRIMITIVE_ORIGINS = new Set<string>([
  'OBSERVER_SYNC_ORIGIN',
  'CONFIG_VALIDATION_REVERT_ORIGIN',
  'CONFIG_FILE_WATCHER_ORIGIN',
  'PARK_SNAPSHOT_ORIGIN',
  'EFFECT_CAPTURE_ORIGIN',
]);

const KNOWN_PAIRED_WRITE_ORIGINS = new Set<string>([
  'MANAGED_RENAME_ORIGIN',
  'ROLLBACK_ORIGIN',
  'FILE_WATCHER_ORIGIN',
  'AGENT_WRITE_ORIGIN',
  'undoOrigin',
]);

const KNOWN_PAIRED_WRITE_ORIGIN_PROPS = new Set<string>([
  'session.origin',
  'session.undoOrigin',
  'templateSession.origin',
]);


interface TransactCall {
  readonly file: string;
  readonly line: number;
  readonly originExpr: string;
  readonly fnBody: Node | undefined;
}

const SERVER_SRC_DIR = join(import.meta.dir);

function loadServerSourceFiles(): ReadonlyArray<readonly [string, SourceFile]> {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      noLib: true,
      allowJs: false,
    },
  });
  const out: Array<readonly [string, SourceFile]> = [];
  const glob = new Glob('**/*.ts');
  for (const rel of glob.scanSync({ cwd: SERVER_SRC_DIR, absolute: false, onlyFiles: true })) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.d.ts')) continue;
    const abs = join(SERVER_SRC_DIR, rel);
    const sf = project.addSourceFileAtPath(abs);
    out.push([abs, sf] as const);
  }
  return out;
}

function renderAccessChain(node: Node): string {
  if (node.isKind(SyntaxKind.Identifier)) return node.getText();
  if (node.isKind(SyntaxKind.PropertyAccessExpression)) {
    return `${renderAccessChain(node.getExpression())}.${node.getName()}`;
  }
  if (node.isKind(SyntaxKind.CallExpression)) {
    return renderAccessChain(node.getExpression());
  }
  return node.getText();
}

function isTransactPropertyAccess(node: Expression): boolean {
  return node.isKind(SyntaxKind.PropertyAccessExpression) && node.getName() === 'transact';
}

function findTransactCalls(file: string, sf: SourceFile): TransactCall[] {
  const calls: TransactCall[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isTransactPropertyAccess(call.getExpression())) continue;
    const args = call.getArguments();
    if (args.length < 2) continue;
    const fnArg = args[0];
    const originArg = args[1];
    const fnBody =
      fnArg &&
      (fnArg.isKind(SyntaxKind.ArrowFunction) || fnArg.isKind(SyntaxKind.FunctionExpression))
        ? fnArg.getBody()
        : undefined;
    calls.push({
      file,
      line: call.getStartLineNumber(),
      originExpr: originArg ? renderAccessChain(originArg) : '<missing>',
      fnBody,
    });
  }
  return calls;
}

function bodyCallsSanctionedPrimitive(body: Node | undefined): {
  matched: boolean;
  matchedName: string | null;
} {
  if (body === undefined) return { matched: false, matchedName: null };
  let matched = false;
  let matchedName: string | null = null;
  body.forEachDescendant((node, traversal) => {
    if (matched) {
      traversal.stop();
      return;
    }
    if (!node.isKind(SyntaxKind.CallExpression)) return;
    const callExpr = node as CallExpression;
    const callee = callExpr.getExpression();
    const calleeName = callee.isKind(SyntaxKind.Identifier)
      ? callee.getText()
      : callee.isKind(SyntaxKind.PropertyAccessExpression)
        ? callee.getName()
        : null;
    if (calleeName === null) return;
    if (SANCTIONED_PRIMITIVES.has(calleeName) || TRANSITIVE_PRIMITIVE_CALLERS.has(calleeName)) {
      matched = true;
      matchedName = calleeName;
      traversal.stop();
    }
  });
  return { matched, matchedName };
}


describe('paired-write enforcement', () => {
  let sources: ReadonlyArray<readonly [string, SourceFile]>;

  beforeAll(() => {
    sources = loadServerSourceFiles();
  }, 30_000);

  test('every transact() call site has a recognized origin', () => {
    const failures: string[] = [];
    for (const [file, sf] of sources) {
      for (const call of findTransactCalls(file, sf)) {
        const segs = call.originExpr.split('.');
        const head = segs[segs.length - 1] ?? call.originExpr;
        const trail = segs.length >= 2 ? `${segs[segs.length - 2]}.${head}` : head;
        const recognized =
          KNOWN_PAIRED_WRITE_ORIGINS.has(head) ||
          SANCTIONED_NON_PRIMITIVE_ORIGINS.has(head) ||
          KNOWN_PAIRED_WRITE_ORIGIN_PROPS.has(trail);
        if (!recognized) {
          failures.push(
            `${relative(SERVER_SRC_DIR, file)}:${call.line} — unrecognized origin "${call.originExpr}". ` +
              `Add it to KNOWN_PAIRED_WRITE_ORIGINS, SANCTIONED_NON_PRIMITIVE_ORIGINS, or ` +
              `KNOWN_PAIRED_WRITE_ORIGIN_PROPS in paired-write-enforcement.test.ts ` +
              `with a comment justifying its category.`,
          );
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Found ${failures.length} unrecognized transact origin(s):\n  ${failures.join('\n  ')}`,
      );
    }
  });

  test('paired-write origins route through a sanctioned primitive', () => {
    const failures: string[] = [];
    for (const [file, sf] of sources) {
      for (const call of findTransactCalls(file, sf)) {
        const head = call.originExpr.split('.').pop() ?? call.originExpr;
        const trail = (() => {
          const segs = call.originExpr.split('.');
          return segs.length >= 2 ? `${segs[segs.length - 2]}.${segs[segs.length - 1]}` : head;
        })();

        const isPaired =
          KNOWN_PAIRED_WRITE_ORIGINS.has(head) || KNOWN_PAIRED_WRITE_ORIGIN_PROPS.has(trail);
        if (!isPaired) continue;

        const { matched, matchedName } = bodyCallsSanctionedPrimitive(call.fnBody);
        if (!matched) {
          failures.push(
            `${relative(SERVER_SRC_DIR, file)}:${call.line} — paired-write origin "${call.originExpr}" ` +
              `does not route through any sanctioned primitive ` +
              `(${[...SANCTIONED_PRIMITIVES, ...TRANSITIVE_PRIMITIVE_CALLERS].join(', ')}). ` +
              `Refactor to call composeAndWriteRawBody / replaceRawBody / deriveFragmentFromYtext.`,
          );
        } else {
          const known =
            SANCTIONED_PRIMITIVES.has(matchedName ?? '') ||
            TRANSITIVE_PRIMITIVE_CALLERS.has(matchedName ?? '');
          if (!known) {
            failures.push(
              `${relative(SERVER_SRC_DIR, file)}:${call.line} — internal classifier bug: ` +
                `matched callee "${matchedName}" not in primitive set.`,
            );
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Found ${failures.length} paired-write transact site(s) bypassing sanctioned primitives:\n  ` +
          failures.join('\n  '),
      );
    }
  });

  test('all three sanctioned primitives are exported from bridge-intake.ts', () => {
    const project = new Project({
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        noLib: true,
        allowJs: false,
      },
    });
    const intakePath = join(SERVER_SRC_DIR, 'bridge-intake.ts');
    const sf = project.addSourceFileAtPath(intakePath);
    const exportedNames = new Set<string>();
    for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      if (!fn.hasExportKeyword()) continue;
      const name = fn.getName();
      if (name) exportedNames.add(name);
    }
    for (const primitive of SANCTIONED_PRIMITIVES) {
      expect(exportedNames.has(primitive)).toBe(true);
    }
  });

  test('allowlists do not overlap (catches accidental double-classification)', () => {
    for (const name of KNOWN_PAIRED_WRITE_ORIGINS) {
      expect(SANCTIONED_NON_PRIMITIVE_ORIGINS.has(name)).toBe(false);
    }
    for (const prop of KNOWN_PAIRED_WRITE_ORIGIN_PROPS) {
      const trailingHead = prop.split('.').pop() ?? prop;
      expect(SANCTIONED_NON_PRIMITIVE_ORIGINS.has(trailingHead)).toBe(false);
    }
  });
});
