/**
 * Structural guard — the app module graph must contain NO runtime
 * (value-import) cycle that crosses the `lib/ ↔ editor/` layering boundary.
 *
 * WHY (the bug): a CI-only, non-deterministic ESM init-order flake surfaces as
 *   `SyntaxError: Export named 'useDocumentTransition' not found in module DocumentContext.tsx`.
 * The export is real (a plain `export function` in DocumentContext.tsx). The cause is
 * that editor/DocumentContext.tsx sat in a value-import SCC closed by a
 * lib/ → editor/ layering inversion in lib/config-provider.tsx. Under Bun's
 * order-sensitive circular-export resolution plus CI 4-vCPU turbo contention, an
 * external importer (components/EditorArea.tsx) occasionally links a named export from
 * DocumentContext before its export environment is fully bound.
 *
 * WHY A STATIC SOURCE GUARD (not a module-load test): the flake is a probabilistic CI-only
 * ESM init-order race that does not reproduce deterministically off CI, so a deterministic
 * *runtime* test of this invariant is out of reach. Acyclicity of the module graph is a
 * property of the source, not of any executable behavior a unit test can observe — the same rationale as
 * provider-pool.attach-boundary.test.ts. components/EditorArea.test.ts stays as the
 * (probabilistic) symptom canary; THIS test pins the deterministic cause.
 *
 * THE CONTRACT: no value-import cycle spans lib/ ↔ editor/. `import type` edges are erased
 * at runtime and are ignored here, so a type-only re-point will NOT satisfy this test —
 * only cutting a lib→editor *value* inversion will. The boundary phrasing is deliberate
 * (rather than the narrower "DocumentContext is acyclic"): it keeps the guard RED until
 * EVERY lib→editor value edge that closes a cycle is gone, so cutting just one edge of a
 * multi-edge entanglement cannot green this test while a residual lib↔editor value cycle remains.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/app/src/editor
const APP_SRC = dirname(HERE); // packages/app/src
const APP_DIR = dirname(APP_SRC); // packages/app
const LIB_DIR = join(APP_SRC, 'lib') + sep;
const EDITOR_DIR = join(APP_SRC, 'editor') + sep;
const DOCUMENT_CONTEXT = join(APP_SRC, 'editor', 'DocumentContext.tsx');
const CONFIG_PROVIDER = join(APP_SRC, 'lib', 'config-provider.tsx');

const isTestLike = (p: string) => /\.(test|test-helper)\.[cm]?tsx?$/.test(p) || p.endsWith('.d.ts');

interface ValueEdge {
  from: string;
  to: string;
  line: number;
  spec: string;
}

// --- Build the value-import (runtime) graph for packages/app/src once. -----------
// ts-morph resolves `@/*` aliases + extensions + index files via the app tsconfig,
// so an edge is recorded only when the specifier resolves to a real in-graph module.
const project = new Project({
  tsConfigFilePath: join(APP_DIR, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: false,
});

const files = project.getSourceFiles().filter((sf) => {
  const p = sf.getFilePath();
  return p.startsWith(APP_SRC + sep) && !isTestLike(p);
});
// ts-morph brands paths as StandardizedFilePath; normalise to plain string so the
// graph keys interoperate with the node:path-derived constants (DOCUMENT_CONTEXT, …).
const fileSet = new Set<string>(files.map((sf) => sf.getFilePath()));

const adjacency = new Map<string, Set<string>>();
const edges: ValueEdge[] = [];

const linkOf = (from: string): Set<string> => {
  let set = adjacency.get(from);
  if (!set) {
    set = new Set();
    adjacency.set(from, set);
  }
  return set;
};

for (const sf of files) {
  const from = sf.getFilePath();

  for (const imp of sf.getImportDeclarations()) {
    if (imp.isTypeOnly()) continue; // `import type { … }` — fully erased at runtime
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue; // external dep or unresolved — not a node in our graph
    const to = target.getFilePath();
    if (to === from || !fileSet.has(to)) continue;
    linkOf(from).add(to);
    edges.push({ from, to, line: imp.getStartLineNumber(), spec: imp.getModuleSpecifierValue() });
  }

  // Re-exports (`export … from '…'`) also load the target at runtime; type-only re-exports do not.
  for (const exp of sf.getExportDeclarations()) {
    if (!exp.getModuleSpecifier() || exp.isTypeOnly()) continue;
    const target = exp.getModuleSpecifierSourceFile();
    if (!target) continue;
    const to = target.getFilePath();
    if (to === from || !fileSet.has(to)) continue;
    linkOf(from).add(to);
    edges.push({
      from,
      to,
      line: exp.getStartLineNumber(),
      spec: exp.getModuleSpecifierValue() ?? '',
    });
  }
}

// --- Tarjan SCC over the value graph (deterministic: sorted node + edge order). ---
const nodes = [...fileSet].sort();

function computeSccGroups(): string[][] {
  const groups: string[][] = [];
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of [...(adjacency.get(v) ?? [])].sort()) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, index.get(w) ?? 0));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const group: string[] = [];
      let w = '';
      do {
        const popped = stack.pop();
        if (popped === undefined) break;
        w = popped;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group);
    }
  };

  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return groups;
}

const sccGroups = computeSccGroups();

// --- Offending cycles: non-trivial SCCs spanning lib/ ↔ editor/. ------------------
const rel = (p: string) => relative(APP_SRC, p);

const offending = sccGroups
  .filter((group) => group.length > 1)
  .filter(
    (group) =>
      group.some((p) => p.startsWith(LIB_DIR)) && group.some((p) => p.startsWith(EDITOR_DIR)),
  );

const buildReport = (): string => {
  const blocks = offending.map((group) => {
    const members = new Set(group);
    const closing = edges
      .filter(
        (e) =>
          members.has(e.from) &&
          members.has(e.to) &&
          e.from.startsWith(LIB_DIR) &&
          e.to.startsWith(EDITOR_DIR),
      )
      .map((e) => `      ${rel(e.from)}:${e.line}  →  ${rel(e.to)}   (${e.spec})`)
      .sort();
    const hasDocContext = members.has(DOCUMENT_CONTEXT);
    return [
      `  • lib/↔editor/ value-import cycle (${group.length} modules)${
        hasDocContext ? ' — includes editor/DocumentContext.tsx' : ''
      }:`,
      `      ${group.map(rel).sort().join('\n      ')}`,
      `    lib/ → editor/ VALUE edge(s) that close it (the layering inversion to cut):`,
      ...closing,
    ].join('\n');
  });

  return [
    `Found ${offending.length} runtime (value-import) cycle(s) crossing the lib/ ↔ editor/ boundary.`,
    `This is the latent SCC behind the CI flake "Export named 'useDocumentTransition' not found in module DocumentContext.tsx".`,
    ``,
    ...blocks,
    ``,
    `Fix: cut the lib/ → editor/ value-import edge(s) listed above — they are the layering`,
    `inversion that closes the cycle. Dependency-invert: move the imported value into lib/, or`,
    `pass it as a prop/parameter from an App-tier host. 'import type' edges are ignored by this`,
    `guard, so a type-only re-point will NOT satisfy it.`,
  ].join('\n');
};

describe('editor module graph layering', () => {
  // Guards against a vacuous pass: a tsconfig glob change (or a broken resolver) could
  // drop one side of the boundary, leaving the cycle assertion to pass for free. A total
  // size floor alone would miss a *partial* failure (e.g. the whole editor/ subtree
  // dropped while ~460 lib/+other nodes remain). So assert BOTH boundary dirs are
  // populated and both anchors are present — the cycle test is only meaningful when the
  // graph actually spans lib/ ↔ editor/.
  test('static import-graph analyser sees both sides of the lib/ ↔ editor/ boundary', () => {
    expect(fileSet.has(DOCUMENT_CONTEXT)).toBe(true);
    expect(fileSet.has(CONFIG_PROVIDER)).toBe(true);
    expect([...fileSet].filter((p) => p.startsWith(EDITOR_DIR)).length).toBeGreaterThan(10);
    expect([...fileSet].filter((p) => p.startsWith(LIB_DIR)).length).toBeGreaterThan(10);
    // Both anchors must have resolved outgoing edges — a dropped `@/` alias would leave a
    // file in fileSet (it exists on disk) but with zero adjacency, vacuously satisfying the
    // cycle assertion for that side of the boundary.
    expect(adjacency.get(DOCUMENT_CONTEXT)?.size ?? 0).toBeGreaterThan(0);
    expect(adjacency.get(CONFIG_PROVIDER)?.size ?? 0).toBeGreaterThan(0);
  });

  // THE CONTRACT: no value-import cycle may span lib/ ↔ editor/. A lib/ value-import back
  // into editor/ that closes a cycle turns this RED and names the offending edge(s) in the
  // failure output.
  test('no runtime (value-import) cycle crosses the lib/ ↔ editor/ boundary', () => {
    expect(offending.length === 0 ? '' : buildReport()).toBe('');
  });
});
