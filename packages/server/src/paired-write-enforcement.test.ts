/**
 * Structural enforcement of the paired-write contract (precedent #38).
 *
 * Walks every `<doc>.transact(fn, origin)` call site in `packages/server/src/`
 * via ts-morph and asserts that paired-write origins route through one of
 * the three sanctioned sibling primitives in `bridge-intake.ts`:
 * `composeAndWriteRawBody`, `replaceRawBody`, `deriveFragmentFromYtext`.
 *
 * Why structural, not textual: the STOP rule "paired-write origins must call
 * a sanctioned primitive" had only a sentence backing it. Past
 * iterations shipped ordering bugs past that sentence. This test fails the
 * build when a new transact site bypasses the primitive — no reviewer-
 * attention budget required.
 *
 * Allowlists are typed `Set<string>` literals colocated with the test (not
 * out-of-band). Adding a new entry forces explicit classification: any new
 * origin name that doesn't match one of the three buckets fails loudly with
 * a message naming the file:line and the unrecognized origin.
 */
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

// ─── Allowlists ──────────────────────────────────────────────

/**
 * The three sibling primitives in `bridge-intake.ts`. Any `doc.transact()` with
 * a paired-write origin must call one of these (directly or transitively).
 */
const SANCTIONED_PRIMITIVES = new Set<string>([
  'composeAndWriteRawBody',
  'replaceRawBody',
  'deriveFragmentFromYtext',
]);

/**
 * Functions that wrap a sanctioned primitive on behalf of callers. A transact
 * body that calls one of these counts as routing through the primitive.
 *
 * `applyDiskContentToDoc` (`external-change.ts`) → `composeAndWriteRawBody`
 * `applyDiskContent` (`persistence.ts` alias of the above for testability)
 * `applyAgentMarkdownWrite` (`agent-sessions.ts`) → `composeAndWriteRawBody`
 *
 * If a future helper joins the chain, add it here. The sibling primitives
 * themselves stay the canonical surface; this set is the ergonomic shim.
 */
const TRANSITIVE_PRIMITIVE_CALLERS = new Set<string>([
  'applyDiskContentToDoc',
  'applyDiskContent',
  'applyAgentMarkdownWrite',
]);

/**
 * Origin names whose transactions do NOT atomically write both Y.Text and
 * Y.XmlFragment, and therefore do not need to call a sanctioned primitive.
 *
 *   OBSERVER_SYNC_ORIGIN — Observer A/B's own cross-CRDT writes (Path B uses
 *     `applyFastDiff` + `updateYFragment` directly; the observers ARE the
 *     bridge, so routing them through the bridge primitives would loop).
 *   CONFIG_VALIDATION_REVERT_ORIGIN, CONFIG_FILE_WATCHER_ORIGIN — config docs
 *     bypass the markdown bridge entirely (Y.Text-only mutation; see
 *     `server-observer-extension.ts` config-doc gate).
 *   PARK_SNAPSHOT_ORIGIN — read-only transact wrapping `serializeDoc` so Y.js
 *     serializes the snapshot atomically against concurrent writers
 *     (`server-factory.ts`). `paired: true` makes observers short-
 *     circuit symmetrically; the body performs no Y.Text/XmlFragment writes,
 *     so no primitive applies.
 *   EFFECT_CAPTURE_ORIGIN — `paired: false`; mutates only Y.Map('agent-effects')
 *     ring-buffer, not the Y.Text/Y.XmlFragment pair (`activity-log.ts`).
 *
 * When `FORM_WRITE_ORIGIN` (currently parked — see `mcp/tools/index.ts`,
 * `mcp/tools/frontmatter-patch.ts`) is reintroduced as a typed origin, add
 * its identifier here so the existing structural test enforces it without an
 * out-of-band rule.
 */
const SANCTIONED_NON_PRIMITIVE_ORIGINS = new Set<string>([
  'OBSERVER_SYNC_ORIGIN',
  'CONFIG_VALIDATION_REVERT_ORIGIN',
  'CONFIG_FILE_WATCHER_ORIGIN',
  'PARK_SNAPSHOT_ORIGIN',
  'EFFECT_CAPTURE_ORIGIN',
]);

/**
 * Origin names whose transactions DO atomically write both Y.Text and
 * Y.XmlFragment. Each must call a sanctioned primitive (or transitive caller)
 * inside its transact body.
 *
 * Per-session origins are normally referenced as `session.origin` /
 * `session.undoOrigin` (matched by `KNOWN_PAIRED_WRITE_ORIGIN_PROPS` below).
 * `undoOrigin` appears here too because `agent-sessions.ts` destructures
 * it from `session` before the transact. The destructured-name
 * pattern is fine; we only need the test to recognize it as paired-write.
 */
const KNOWN_PAIRED_WRITE_ORIGINS = new Set<string>([
  'MANAGED_RENAME_ORIGIN',
  'ROLLBACK_ORIGIN',
  'FILE_WATCHER_ORIGIN',
  'AGENT_WRITE_ORIGIN',
  'undoOrigin',
]);

/**
 * Per-session paired-write origins. Match by property-access path, not by the
 * head identifier (which can be `session`, `dc`, etc.). `createSessionOrigin`
 * + `createUndoOrigin` in `agent-sessions.ts` make these `PairedWriteOrigin`
 * by construction. `templateSession.origin` is the managed-artifact template
 * PUT handler's per-session origin (`api-extension.ts`) — a distinct local name
 * for the same `getSession(...).origin` value, used in the canonical
 * `transact(fn, session.origin)` pattern through `composeAndWriteRawBody`.
 */
const KNOWN_PAIRED_WRITE_ORIGIN_PROPS = new Set<string>([
  'session.origin',
  'session.undoOrigin',
  'templateSession.origin',
]);

// ─── AST helpers ─────────────────────────────────────────────

interface TransactCall {
  readonly file: string;
  readonly line: number;
  readonly originExpr: string;
  readonly fnBody: Node | undefined;
}

const SERVER_SRC_DIR = join(import.meta.dir);

/**
 * Reuse a single Project across all source files. With `skipFileDependencyResolution`
 * + `skipLoadingLibFiles` + `noLib`, ts-morph parses each added file but does NOT
 * walk its imports — this keeps the scan local to the explicitly-added set and
 * matches the prior raw-`ts.createSourceFile` semantics.
 */
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

/**
 * Render a property-access chain (`session.dc.document.transact`) to a
 * dotted string. For nested calls (`getOrigin().origin`), recurse through the
 * callee so the trailing accessor stays visible for origin matching.
 */
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
    // Resolve callee — Identifier (`composeAndWriteRawBody(...)`) or
    // PropertyAccess (`mod.composeAndWriteRawBody(...)`).
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

// ─── Tests ───────────────────────────────────────────────────

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
          // Confirm the matched name is actually one of the allowed callees.
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
