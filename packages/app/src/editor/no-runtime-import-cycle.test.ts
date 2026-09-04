import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = dirname(HERE);
const APP_DIR = dirname(APP_SRC);
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

const project = new Project({
  tsConfigFilePath: join(APP_DIR, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: false,
});

const files = project.getSourceFiles().filter((sf) => {
  const p = sf.getFilePath();
  return p.startsWith(APP_SRC + sep) && !isTestLike(p);
});
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
    if (imp.isTypeOnly()) continue;
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue;
    const to = target.getFilePath();
    if (to === from || !fileSet.has(to)) continue;
    linkOf(from).add(to);
    edges.push({ from, to, line: imp.getStartLineNumber(), spec: imp.getModuleSpecifierValue() });
  }

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
  test('static import-graph analyser sees both sides of the lib/ ↔ editor/ boundary', () => {
    expect(fileSet.has(DOCUMENT_CONTEXT)).toBe(true);
    expect(fileSet.has(CONFIG_PROVIDER)).toBe(true);
    expect([...fileSet].filter((p) => p.startsWith(EDITOR_DIR)).length).toBeGreaterThan(10);
    expect([...fileSet].filter((p) => p.startsWith(LIB_DIR)).length).toBeGreaterThan(10);
    expect(adjacency.get(DOCUMENT_CONTEXT)?.size ?? 0).toBeGreaterThan(0);
    expect(adjacency.get(CONFIG_PROVIDER)?.size ?? 0).toBeGreaterThan(0);
  });

  test('no runtime (value-import) cycle crosses the lib/ ↔ editor/ boundary', () => {
    expect(offending.length === 0 ? '' : buildReport()).toBe('');
  });
});
