import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from '../../../src/shared/terminal-platform.ts';
import { SPEC_PLATFORM_GATES, SUPPORTED_PLATFORMS } from './platform-gate';

const SMOKE_DIR = join(__dirname, '..');

const GATE_METHODS = new Set(['skip', 'fixme']);

const SHARED_PREDICATES: ReadonlySet<string> = new Set([
  'PLATFORM_SUPPORTED',
  'PTY_PLATFORM_SUPPORTED',
]);

const LOCAL_PREDICATE_DEFINITIONS: Readonly<Record<string, string>> = {
  DARWIN: "process.platform === 'darwin'",
  WINDOWS: "process.platform === 'win32'",
};

interface PredicateConfig {
  readonly shared: ReadonlySet<string>;
  readonly local: Readonly<Record<string, string>>;
}

const DEFAULT_PREDICATES: PredicateConfig = {
  shared: SHARED_PREDICATES,
  local: LOCAL_PREDICATE_DEFINITIONS,
};

function platformPredicates(config: PredicateConfig): Set<string> {
  return new Set([...config.shared, ...Object.keys(config.local)]);
}

const SHARED_MODULE_SUFFIX = '_helpers/platform-gate';

const PLATFORM_IRRELEVANT_PREDICATES = new Set([
  'SMOKE_ENABLED',
  'TARGET',
  'BUILD_EXISTS',
  'ENABLED',
  'appIsRunning',
  'preview',
]);

function createParser(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { noLib: true },
  });
}

function referencedIdentifiers(node: Node): string[] {
  const names: string[] = [];
  const walk = (current: Node): void => {
    if (Node.isIdentifier(current)) {
      names.push(current.getText());
      return;
    }
    if (Node.isPropertyAccessExpression(current)) {
      walk(current.getExpression());
      return;
    }
    current.forEachChild(walk);
  };
  walk(node);
  return names;
}

function isGateCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (!GATE_METHODS.has(callee.getName())) return false;
  const receiver = callee.getExpression();
  if (Node.isIdentifier(receiver)) return receiver.getText() === 'test';
  return (
    Node.isPropertyAccessExpression(receiver) &&
    receiver.getName() === 'describe' &&
    Node.isIdentifier(receiver.getExpression()) &&
    receiver.getExpression().getText() === 'test'
  );
}

function assertPredicateBinding(
  source: SourceFile,
  name: string,
  fileLabel: string,
  config: PredicateConfig,
): void {
  const declaration = source.getVariableDeclaration(name);
  const importedFrom = source
    .getImportDeclarations()
    .filter((decl) =>
      decl
        .getNamedImports()
        .some((named) => (named.getAliasNode() ?? named.getNameNode()).getText() === name),
    )
    .map((decl) => decl.getModuleSpecifierValue());

  if (config.shared.has(name)) {
    if (declaration !== undefined) {
      throw new Error(
        `${fileLabel} declares its own \`${name}\`, which ${SHARED_MODULE_SUFFIX} owns. ` +
          'Import it instead, so every spec gates on one definition.',
      );
    }
    if (!importedFrom.some((specifier) => specifier.endsWith(SHARED_MODULE_SUFFIX))) {
      throw new Error(
        `${fileLabel} gates on \`${name}\` without importing it from ${SHARED_MODULE_SUFFIX}. ` +
          'The guard can only vouch for that definition.',
      );
    }
    return;
  }

  const expected = config.local[name];
  if (expected === undefined) {
    throw new Error(
      `${fileLabel} gates on \`${name}\`, which counts as a platform predicate but has no ` +
        'binding rule. Add it to SHARED_PREDICATES if platform-gate.ts exports it, or to ' +
        'LOCAL_PREDICATE_DEFINITIONS with the initializer every spec must declare it with.',
    );
  }
  if (importedFrom.length > 0) {
    throw new Error(
      `${fileLabel} imports \`${name}\` rather than declaring it. Consolidating the per-spec ` +
        'platform constants onto a shared module re-points every spec that gates on them, so it ' +
        `needs its own evidence. To accept it: move '${name}' out of LOCAL_PREDICATE_DEFINITIONS ` +
        'and into SHARED_PREDICATES in platform-gate.test.ts, export it from platform-gate.ts so ' +
        'one definition serves every spec, and cite a green run on the platforms affected.',
    );
  }
  if (declaration === undefined) {
    throw new Error(`${fileLabel} gates on \`${name}\` but never declares it.`);
  }
  const initializer = declaration.getInitializer()?.getText().replace(/\s+/g, ' ').trim();
  if (initializer !== expected) {
    throw new Error(
      `${fileLabel} declares \`const ${name} = ${initializer}\`, but this guard reads every ` +
        `\`${name}\` gate as meaning \`${expected}\`. Changing what the constant evaluates to ` +
        'moves this spec’s platform set without changing any gate condition, so it cannot be ' +
        'accepted silently.\n\n' +
        'If this spec should run somewhere else, say so in the gate rather than in the constant: ' +
        'use a predicate that already means what you want, or a new constant named for what it ' +
        'means, and classify that name in platform-gate.test.ts.\n\n' +
        `If \`${name}\` itself should mean something different, that is a suite-wide decision, ` +
        'not a local edit: every spec declaring it moves together with the entry here, and each ' +
        'one needs a green run on the platforms it newly admits.',
    );
  }
}

function deriveGates(
  rawSrc: string,
  fileLabel: string,
  config: PredicateConfig = DEFAULT_PREDICATES,
): string[] {
  const source = createParser().createSourceFile(fileLabel, rawSrc);
  const gates: string[] = [];
  const platformNames = platformPredicates(config);

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isGateCall(call)) continue;
    const condition = call.getArguments()[0];
    if (condition === undefined || Node.isStringLiteral(condition)) continue;
    if (Node.isNoSubstitutionTemplateLiteral(condition)) continue;

    const names = referencedIdentifiers(condition);
    const text = condition.getText().replace(/\s+/g, ' ').trim();
    const gated = names.filter((name) => platformNames.has(name));
    if (gated.length > 0) {
      for (const name of new Set(gated)) assertPredicateBinding(source, name, fileLabel, config);
      gates.push(text);
      continue;
    }
    const unclassified = names.filter((name) => !PLATFORM_IRRELEVANT_PREDICATES.has(name));
    if (unclassified.length > 0) {
      const line = condition.getStartLineNumber();
      throw new Error(
        `${fileLabel}:${line} gates on unclassified predicate(s) ${unclassified.join(', ')} in \`${text}\`. ` +
          'If it constrains which platforms run the spec, add it to SHARED_PREDICATES (exported ' +
          'from platform-gate.ts) or LOCAL_PREDICATE_DEFINITIONS (declared per spec, with its ' +
          'required initializer); if it does not, add it to PLATFORM_IRRELEVANT_PREDICATES. All ' +
          'three live in platform-gate.test.ts.',
      );
    }
  }

  return gates;
}

function listSpecFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort();
}

interface Divergence {
  file: string;
  pinned: string;
  derived: string;
}

const NOT_IN_ROSTER = '(not in roster)';
const FILE_DELETED = '(file deleted)';
const UNGATED = '(no platform gate)';

function render(gates: readonly string[]): string {
  return gates.length === 0 ? UNGATED : gates.map((gate) => `\`${gate}\``).join(' + ');
}

function sameGates(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((gate, index) => gate === b[index]);
}

function diffRoster(derivedByFile: Readonly<Record<string, readonly string[]>>): Divergence[] {
  const roster: Readonly<Record<string, readonly string[]>> = SPEC_PLATFORM_GATES;
  const out: Divergence[] = [];
  for (const [file, derived] of Object.entries(derivedByFile)) {
    const pinned = roster[file];
    if (pinned === undefined) {
      out.push({ file, pinned: NOT_IN_ROSTER, derived: render(derived) });
    } else if (!sameGates(pinned, derived)) {
      out.push({ file, pinned: render(pinned), derived: render(derived) });
    }
  }
  for (const [file, pinned] of Object.entries(roster)) {
    if (!(file in derivedByFile)) {
      out.push({ file, pinned: render(pinned), derived: FILE_DELETED });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function deriveCorpus(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of listSpecFiles(SMOKE_DIR)) {
    out[file] = deriveGates(readFileSync(join(SMOKE_DIR, file), 'utf8'), file);
  }
  return out;
}

function formatDivergences(divergences: readonly Divergence[]): string {
  if (divergences.length === 0) return '';
  const lines = [
    `${divergences.length} smoke spec(s) no longer match SPEC_PLATFORM_GATES in _helpers/platform-gate.ts:`,
    '',
  ];
  for (const d of divergences) {
    lines.push(`  ${d.file}: roster says ${d.pinned}, source says ${d.derived}`);
  }
  lines.push('');
  lines.push('Update the roster entry to match, in the same change that moved the gate.');
  lines.push('Widening a spec onto platforms it did not run on before — flipping a gate,');
  lines.push('dropping one, or inverting its polarity — needs a run of THAT spec, green,');
  lines.push('on those platforms; cite it in the pull request. A spec is not fit for a');
  lines.push('platform because its filename reads like the rest of the batch. Narrowing a');
  lines.push('spec, and adding a newly written one, need no run. The entry lists every');
  lines.push('gate in the file in source order, so adding or removing a gated describe');
  lines.push('bumps it too.');
  return lines.join('\n');
}

describe('platform-gate roster — smoke-spec gate enforcement', () => {
  test('every smoke spec carries the gates SPEC_PLATFORM_GATES pins it to', () => {
    const corpus = deriveCorpus();
    expect(Object.keys(corpus).length).toBeGreaterThan(20);

    const divergences = diffRoster(corpus);
    expect(divergences, formatDivergences(divergences)).toEqual([]);
  });
});

describe('deriveGates — derivation logic', () => {
  const DARWIN_DECL = "const DARWIN = process.platform === 'darwin';\n";
  const WINDOWS_DECL = "const WINDOWS = process.platform === 'win32';\n";
  const SHARED_IMPORT =
    "import { PLATFORM_SUPPORTED, PTY_PLATFORM_SUPPORTED } from './_helpers/platform-gate';\n";
  const derive = (src: string): string[] =>
    deriveGates(`${SHARED_IMPORT}${DARWIN_DECL}${WINDOWS_DECL}${src}`, 'synthetic.e2e.ts');

  test('reads a negated platform gate', () => {
    expect(derive('test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);')).toEqual([
      '!PLATFORM_SUPPORTED',
    ]);
  });

  test('reads a POSITIVE (exclusion) gate', () => {
    expect(derive("test.skip(DARWIN, 'macOS composes its own chrome.');")).toEqual(['DARWIN']);
  });

  test('reads a compound condition verbatim', () => {
    expect(derive("test.skip(WINDOWS || TARGET.mode === 'packaged', 'reason');")).toEqual([
      "WINDOWS || TARGET.mode === 'packaged'",
    ]);
  });

  test('reads a conditional-function gate', () => {
    expect(derive("test.skip(() => !DARWIN, 'reason');")).toEqual(['() => !DARWIN']);
  });

  test('reads a gate on test.describe', () => {
    expect(derive("test.describe.skip(!DARWIN, 'reason', () => {});")).toEqual(['!DARWIN']);
  });

  test('collapses a multi-line condition to one line', () => {
    const src = `
      test.skip(
        !PTY_PLATFORM_SUPPORTED,
        PTY_PLATFORM_SKIP_REASON,
      );
    `;
    expect(derive(src)).toEqual(['!PTY_PLATFORM_SUPPORTED']);
  });

  test('keeps every gate in source order, including repeats', () => {
    const src = `
      test.describe('a', () => { test.skip(!PLATFORM_SUPPORTED, R); });
      test.describe('b', () => { test.skip(DARWIN, R); });
      test.describe('c', () => { test.skip(!PLATFORM_SUPPORTED, R); });
    `;
    expect(derive(src)).toEqual(['!PLATFORM_SUPPORTED', 'DARWIN', '!PLATFORM_SUPPORTED']);
  });

  test('ignores a platform-irrelevant gate', () => {
    expect(derive("test.skip(!SMOKE_ENABLED, 'set the env var');")).toEqual([]);
    expect(derive('test.skip(!TARGET.exists, TARGET.missingReason);')).toEqual([]);
  });

  test('ignores the named-test skip form', () => {
    expect(derive("test.skip('J2 dispatch — deferred', () => {});")).toEqual([]);
  });

  test('ignores a condition naming no identifiers, as the display-size bails do', () => {
    expect(derive("test.skip(true, 'work area cannot hold the requested width');")).toEqual([]);
  });

  test('reads a conditional test.fixme the same way', () => {
    expect(derive("test.fixme(WINDOWS, 'reason');")).toEqual(['WINDOWS']);
    expect(derive("test.fixme('broken test title', async () => {});")).toEqual([]);
  });

  test('a commented-out gate does not count', () => {
    const src = `
      // test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
      test.skip(!DARWIN, 'macOS-only surface');
    `;
    expect(derive(src)).toEqual(['!DARWIN']);
  });

  test('a gate named in a doc block or a string does not count', () => {
    const src = `
      /** Widened via test.skip(!PLATFORM_SUPPORTED) once; reverted. */
      const note = 'test.skip(WINDOWS, "x")';
      test.skip(!DARWIN, 'macOS-only surface');
    `;
    expect(derive(src)).toEqual(['!DARWIN']);
  });

  test('a predicate named outside a skip call does not count', () => {
    const src = `
      const gate = PLATFORM_SUPPORTED;
      if (!PLATFORM_SUPPORTED) return;
      test.skip(!DARWIN, 'macOS-only surface');
    `;
    expect(derive(src)).toEqual(['!DARWIN']);
  });

  test('THROWS on an unclassified predicate rather than dropping it', () => {
    expect(() => derive("test.skip(!SOME_NEW_GATE, 'reason');")).toThrow(/SOME_NEW_GATE/);
    expect(() => derive("test.skip(!SOME_NEW_GATE, 'reason');")).toThrow(
      /SHARED_PREDICATES|LOCAL_PREDICATE_DEFINITIONS|PLATFORM_IRRELEVANT_PREDICATES/,
    );
  });

  test('the unclassified-predicate error names the file and the 1-based line', () => {
    const src = "const a = 1;\nconst b = 2;\ntest.skip(!MYSTERY, 'reason');";
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/synthetic\.e2e\.ts:3 /);
  });
});

describe('deriveGates — predicate bindings', () => {
  const gate = "test.skip(!DARWIN, 'macOS-only surface');";

  test('accepts the canonical local declaration', () => {
    const src = `const DARWIN = process.platform === 'darwin';\n${gate}`;
    expect(deriveGates(src, 'synthetic.e2e.ts')).toEqual(['!DARWIN']);
  });

  test('THROWS when a local DARWIN is broadened, though every gate is unchanged', () => {
    const src = `const DARWIN = process.platform === 'darwin' || process.platform === 'linux';\n${gate}`;
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/DARWIN/);
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/without changing any gate/);
  });

  test('THROWS when a spec gates on DARWIN without declaring it', () => {
    expect(() => deriveGates(gate, 'synthetic.e2e.ts')).toThrow(/never declares it/);
  });

  test('THROWS when the per-spec constants are consolidated onto a shared module', () => {
    const src = `import { DARWIN } from './_helpers/platform-gate';\n${gate}`;
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/needs its own evidence/);
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/into SHARED_PREDICATES/);
  });

  test('the consolidation remedy clears it, for the two steps executable here', () => {
    const src = `import { DARWIN } from './_helpers/platform-gate';\n${gate}`;
    const consolidated: PredicateConfig = {
      shared: new Set([...SHARED_PREDICATES, 'DARWIN']),
      local: Object.fromEntries(
        Object.entries(LOCAL_PREDICATE_DEFINITIONS).filter(([name]) => name !== 'DARWIN'),
      ),
    };
    expect(deriveGates(src, 'synthetic.e2e.ts', consolidated)).toEqual(['!DARWIN']);
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/needs its own evidence/);
  });

  test('the local action the redefinition message leads with clears it', () => {
    const src = [
      "const DARWIN_OR_LINUX = process.platform === 'darwin' || process.platform === 'linux';",
      "test.skip(!DARWIN_OR_LINUX, 'reason');",
    ].join('\n');
    const widened: PredicateConfig = {
      shared: SHARED_PREDICATES,
      local: {
        ...LOCAL_PREDICATE_DEFINITIONS,
        DARWIN_OR_LINUX: "process.platform === 'darwin' || process.platform === 'linux'",
      },
    };
    expect(deriveGates(src, 'synthetic.e2e.ts', widened)).toEqual(['!DARWIN_OR_LINUX']);
    const redefined = [
      "const DARWIN = process.platform === 'darwin' || process.platform === 'linux';",
      gate,
    ].join('\n');
    expect(() => deriveGates(redefined, 'synthetic.e2e.ts')).toThrow(/suite-wide decision/);
    expect(() => deriveGates(redefined, 'synthetic.e2e.ts')).toThrow(
      /say so in the gate rather than in the constant/,
    );
  });

  test('THROWS when a shared predicate is re-declared locally', () => {
    const src = `const PLATFORM_SUPPORTED = true;\ntest.skip(!PLATFORM_SUPPORTED, R);`;
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/declares its own/);
  });

  test('THROWS when a shared predicate is used without importing it', () => {
    const src = 'test.skip(!PTY_PLATFORM_SUPPORTED, R);';
    expect(() => deriveGates(src, 'synthetic.e2e.ts')).toThrow(/without importing it/);
  });
});

describe('shared predicates — meaning', () => {
  test('the terminal platform set is the three desktop targets', () => {
    expect(isTerminalPlatform('darwin')).toBe(true);
    expect(isTerminalPlatform('linux')).toBe(true);
    expect(isTerminalPlatform('win32')).toBe(true);
  });

  test('the harness-supported platform set is the three desktop targets', () => {
    expect([...SUPPORTED_PLATFORMS].sort()).toEqual(['darwin', 'linux', 'win32']);
  });
});

describe('listSpecFiles — corpus enumeration', () => {
  test('finds a spec nested one level down, posix-keyed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-spec-listing-'));
    try {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'flat.e2e.ts'), '');
      writeFileSync(join(dir, 'nested', 'deep.e2e.ts'), '');
      writeFileSync(join(dir, 'nested', 'helper.ts'), '');
      expect(listSpecFiles(dir)).toEqual(['flat.e2e.ts', 'nested/deep.e2e.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diffRoster — falsifiability', () => {
  const darwinSpec = 'share-receive-multi-worktree.e2e.ts';
  const nestedGateSpec = 'note-window.e2e.ts';
  const exclusionGateSpec = 'window-chrome.e2e.ts';
  const rosterAsDerived = (): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(SPEC_PLATFORM_GATES).map(([file, gates]) => [file, [...gates]]),
    );

  test('the roster agrees with itself', () => {
    expect(diffRoster(rosterAsDerived())).toEqual([]);
  });

  test('flags a darwin-only spec widened to cross-platform', () => {
    const corpus = rosterAsDerived();
    corpus[darwinSpec] = ['!PLATFORM_SUPPORTED'];
    expect(diffRoster(corpus)).toEqual([
      { file: darwinSpec, pinned: '`!DARWIN`', derived: '`!PLATFORM_SUPPORTED`' },
    ]);
  });

  test('flags a gate whose polarity flipped, which a category name would hide', () => {
    const corpus = rosterAsDerived();
    corpus[darwinSpec] = ['DARWIN'];
    expect(diffRoster(corpus)).toEqual([
      { file: darwinSpec, pinned: '`!DARWIN`', derived: '`DARWIN`' },
    ]);
  });

  test('flags a deleted inner gate that leaves the file-level gate intact', () => {
    const corpus = rosterAsDerived();
    corpus[nestedGateSpec] = ['!PLATFORM_SUPPORTED'];
    expect(diffRoster(corpus)).toEqual([
      {
        file: nestedGateSpec,
        pinned: '`!PLATFORM_SUPPORTED` + `!DARWIN`',
        derived: '`!PLATFORM_SUPPORTED`',
      },
    ]);
  });

  test('flags a dropped exclusion gate between two identical gates', () => {
    const corpus = rosterAsDerived();
    corpus[exclusionGateSpec] = ['!PLATFORM_SUPPORTED', '!PLATFORM_SUPPORTED'];
    expect(diffRoster(corpus)).toEqual([
      {
        file: exclusionGateSpec,
        pinned: '`!PLATFORM_SUPPORTED` + `DARWIN` + `!PLATFORM_SUPPORTED`',
        derived: '`!PLATFORM_SUPPORTED` + `!PLATFORM_SUPPORTED`',
      },
    ]);
  });

  test('flags a spec the roster does not carry', () => {
    const corpus = rosterAsDerived();
    corpus['no-such-spec.e2e.ts'] = ['!PLATFORM_SUPPORTED'];
    expect(diffRoster(corpus)).toEqual([
      { file: 'no-such-spec.e2e.ts', pinned: NOT_IN_ROSTER, derived: '`!PLATFORM_SUPPORTED`' },
    ]);
  });

  test('flags a roster entry whose spec is gone', () => {
    const corpus = rosterAsDerived();
    delete corpus[darwinSpec];
    expect(diffRoster(corpus)).toEqual([
      { file: darwinSpec, pinned: '`!DARWIN`', derived: FILE_DELETED },
    ]);
  });

  test('flags a spec that lost its platform gate entirely', () => {
    const corpus = rosterAsDerived();
    corpus[darwinSpec] = [];
    expect(diffRoster(corpus)).toEqual([
      { file: darwinSpec, pinned: '`!DARWIN`', derived: UNGATED },
    ]);
  });
});
