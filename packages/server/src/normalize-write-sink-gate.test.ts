/**
 * `normalizeBridge` output must never drive a byte write.
 *
 * `normalizeBridge` collapses tolerance-class differences (trailing whitespace,
 * blank-line runs, escape forms) so two representations can be COMPARED for
 * bridge equality. Its output is a lossy canonical form — writing it back to
 * disk or into `Y.Text`/`Y.XmlFragment` would silently rewrite the user's
 * byte-sacred source (precedent #57). Every `normalizeBridge` caller today is
 * comparison-only; this gate keeps it that way by failing the build when a
 * `normalizeBridge` result flows (directly, or via a one-hop local const) into
 * a byte-write sink argument.
 *
 * Blindness residual: cross-function flow (a function that RETURNS
 * `normalizeBridge` output whose caller then writes it) is not statically
 * traced here — that needs whole-program type resolution. The compensating
 * controls are the manual audit that verified every caller comparison-only and
 * the per-write-path byte-sacred discipline (precedent #57). The realistic
 * regression — someone writing a freshly-normalized value — is caught.
 */
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

const SINK_FUNCTIONS = new Set<string>([
  'tracedWriteFile',
  'tracedWriteFileSync',
  'writeFile',
  'writeFileSync',
  'composeAndWriteRawBody',
  'replaceRawBody',
]);

const SINK_METHODS = new Set<string>(['insert', 'splice', 'applyDelta', 'push', 'unshift']);

const NORMALIZE_FN = 'normalizeBridge';

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

function containsNormalize(node: Node): boolean {
  if (Node.isCallExpression(node) && calleeName(node) === NORMALIZE_FN) return true;
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((c) => calleeName(c) === NORMALIZE_FN);
}

function taintedConstNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    if (containsNormalize(init)) {
      const nameNode = decl.getNameNode();
      if (nameNode.isKind(SyntaxKind.Identifier)) names.add(nameNode.getText());
    }
  }
  return names;
}

function isSinkCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const name = calleeName(call);
  if (!name) return false;
  if (SINK_FUNCTIONS.has(name)) return true;
  return call.getExpression().isKind(SyntaxKind.PropertyAccessExpression) && SINK_METHODS.has(name);
}

function analyzeSourceFile(rel: string, sf: SourceFile): Violation[] {
  const tainted = taintedConstNames(sf);
  const violations: Violation[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isSinkCall(call)) continue;
    for (const arg of call.getArguments()) {
      const argTainted =
        containsNormalize(arg) || (arg.isKind(SyntaxKind.Identifier) && tainted.has(arg.getText()));
      if (argTainted) {
        violations.push({
          file: rel,
          line: call.getStartLineNumber(),
          detail: `${calleeName(call)}(...) receives a normalizeBridge-derived (canonicalized) value as a byte-write argument`,
        });
        break;
      }
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
      if (statSync(abs).isDirectory()) walk(abs);
      else if (isScannableFile(entry) && readFileSync(abs, 'utf8').includes(`${NORMALIZE_FN}(`))
        out.push(abs);
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

describe('normalize-write-sink gate', () => {
  it('no normalizeBridge output flows into a byte-write sink', () => {
    const project = newProject();
    const files: Array<readonly [string, SourceFile]> = [];
    for (const root of SCAN_ROOTS) {
      for (const abs of collectCandidateFiles(root)) {
        files.push([abs.slice(packagesDir.length + 1), project.addSourceFileAtPath(abs)] as const);
      }
    }
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(([rel, sf]) => analyzeSourceFile(rel, sf));
    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}:${v.line} — ${v.detail}`).join('\n');
      throw new Error(
        `Found ${violations.length} normalizeBridge-to-write-sink flow(s):\n${lines}\n` +
          `normalizeBridge is comparison-only; write RAW bytes, never the canonicalized form.`,
      );
    }
  });

  it('catches a direct normalizeBridge-to-sink write (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-direct.ts',
      `function w(path: string, body: string, ytext: any) {
         tracedWriteFile(path, normalizeBridge(body));
         ytext.insert(0, normalizeBridge(body));
       }`,
    );
    expect(analyzeSourceFile('planted-direct.ts', sf)).toHaveLength(2);
  });

  it('catches a one-hop normalizeBridge-to-sink write (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-onehop.ts',
      `function w(path: string, body: string) {
         const canonical = normalizeBridge(body);
         tracedWriteFile(path, canonical);
       }`,
    );
    const violations = analyzeSourceFile('planted-onehop.ts', sf);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('normalizeBridge-derived');
  });

  it('passes comparison-only and raw-byte-write sites (positive controls)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'controls.ts',
      `function compare(disk: string, base: string) {
         return normalizeBridge(disk) === normalizeBridge(base);
       }
       function rawWrite(path: string, rawBody: string, ytext: any) {
         const norm = normalizeBridge(rawBody);
         if (norm !== '') tracedWriteFile(path, rawBody);
         ytext.insert(0, rawBody);
       }`,
    );
    expect(analyzeSourceFile('controls.ts', sf)).toHaveLength(0);
  });
});
