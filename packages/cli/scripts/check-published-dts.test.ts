import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJsoncOrError } from '../../../scripts/read-jsonc.mjs';
import {
  checkProjectFences,
  checkSurface,
  classifyRun,
  evaluate,
  isClean,
  PINNED_THIRD_PARTY_INLINING_ARTIFACTS,
  PUBLISHED_SURFACE_BASELINE,
  partitionOutput,
  readPublishedSurface,
  reconcile,
} from './check-published-dts.mjs';

type Pin = {
  origin: string;
  mechanism: string;
  file: string;
  code: string;
  message: string;
  count?: number;
};
type Diagnostic = { file: string; line: number; code: string; message: string };
type Tally = { signature: string; count: number };
type MissingTally = Tally & { origin: string; mechanism: string };
type Baseline = { anyCeiling: number; unknownCeiling: number; exportedSymbols: string[] };

const PINS = PINNED_THIRD_PARTY_INLINING_ARTIFACTS as Pin[];
const BASELINE = PUBLISHED_SURFACE_BASELINE as Baseline;

const asDiagnostics = (pinned: Pin[]): Diagnostic[] =>
  pinned.flatMap((entry, index) =>
    Array.from({ length: entry.count ?? 1 }, (_unused, occurrence) => ({
      file: entry.file,
      line: 100 + index * 10 + occurrence,
      code: entry.code,
      message: entry.message,
    })),
  );

const PINNED_OCCURRENCES = PINS.reduce((sum: number, pin: Pin) => sum + (pin.count ?? 1), 0);

const totalCount = (tallies: Tally[]) => tallies.reduce((sum, entry) => sum + entry.count, 0);

const sig = (pin: Pin) => `${pin.file}: ${pin.code}: ${pin.message}`;

const exportStatement = (names: string[]) => `export { ${names.join(', ')} };`;

describe('published declaration reconciliation', () => {
  it('accepts a build whose diagnostics are exactly the pinned third-party artifacts', () => {
    const result = reconcile(asDiagnostics(PINS), PINS);

    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('accepts the pinned artifacts at different line numbers, since every rebuild moves them', () => {
    const shifted = asDiagnostics(PINS).map((diagnostic: Diagnostic) => ({
      ...diagnostic,
      line: diagnostic.line + 9000,
    }));

    expect(reconcile(shifted, PINS)).toEqual({
      unexpected: [],
      missing: [],
    });
  });

  it('reports a diagnostic that is not pinned, which is the dangling-sibling-type case', () => {
    const withDanglingReference = [
      ...asDiagnostics(PINS),
      {
        file: 'dist/index.d.mts',
        line: 12020,
        code: 'TS2304',
        message: "Cannot find name 'ALL_EDITOR_IDS'.",
      },
    ];

    const result = reconcile(withDanglingReference, PINS);

    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([
      { signature: "dist/index.d.mts: TS2304: Cannot find name 'ALL_EDITOR_IDS'.", count: 1 },
    ]);
  });

  it('reports an extra occurrence of an already-pinned diagnostic rather than absorbing it', () => {
    const [tiptap] = PINS.filter((e: Pin) => e.code === 'TS2314');
    expect(tiptap.count).toBe(2);

    const withThird = [
      ...asDiagnostics(PINS),
      { file: tiptap.file, line: 9999, code: tiptap.code, message: tiptap.message },
    ];

    expect(reconcile(withThird, PINS).unexpected).toEqual([{ signature: sig(tiptap), count: 1 }]);
  });

  it('does not let the same message from a dependency declaration cover a pin on the published file', () => {
    const movedToDependency = asDiagnostics(PINS).map((diagnostic: Diagnostic) => ({
      ...diagnostic,
      file: 'node_modules/@tiptap/core/dist/index.d.ts',
    }));

    const result = reconcile(movedToDependency, PINS) as {
      unexpected: Tally[];
      missing: MissingTally[];
    };

    expect(totalCount(result.unexpected)).toBe(PINNED_OCCURRENCES);
    expect(totalCount(result.missing)).toBe(PINNED_OCCURRENCES);
  });

  it('reports a pinned diagnostic that stopped appearing, so an upstream fix shrinks the pin', () => {
    const [firstPin] = PINS;
    const [, ...remainingOccurrences] = asDiagnostics(PINS);

    const result = reconcile(remainingOccurrences, PINS) as {
      unexpected: Tally[];
      missing: MissingTally[];
    };

    expect(result.unexpected).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].signature).toBe(sig(firstPin));
    expect(result.missing[0].count).toBe(1);
    expect(result.missing[0].origin).toBe(firstPin.origin);
    expect(result.missing[0].mechanism).toBeTruthy();
  });

  it('carries the provenance of every stale pin so the operator knows what it covered', () => {
    const missing = reconcile([], PINS) as { missing: MissingTally[] };

    for (const entry of missing.missing) {
      expect(entry.origin).toBeTruthy();
      expect(entry.mechanism).toBeTruthy();
    }
    expect(missing.missing.map((entry) => entry.origin)).toContain('@tiptap/core');
  });

  it('fails loudly rather than silently passing when no diagnostics are observed at all', () => {
    const result = reconcile([], PINS);

    expect(totalCount(result.missing)).toBe(PINNED_OCCURRENCES);
    expect(result.missing).toHaveLength(new Set(PINS.map(sig)).size);
  });
});

describe('tsc output parsing', () => {
  const OUTPUT = [
    "dist/index.d.mts(927,63): error TS2636: Type '$ZodObjectInternals<sub-Shape, Config>' is not assignable to type '$ZodObjectInternals<super-Shape, Config>' as implied by variance annotation.",
    "  Types of property 'output' are incompatible.",
    "    Type 'A' is not assignable to type 'B'.",
    "dist/index.d.mts(9284,28): error TS2314: Generic type 'NodeConfig<Options, Storage>' requires 2 type argument(s).",
    '',
  ].join('\n');

  it('reads one diagnostic per top-level line and ignores the indented explanation lines', () => {
    const { diagnostics, residual } = partitionOutput(OUTPUT);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ code: 'TS2636', line: 927, file: 'dist/index.d.mts' });
    expect(diagnostics[1]).toMatchObject({ code: 'TS2314', line: 9284 });
    expect(diagnostics[1].message).toBe(
      "Generic type 'NodeConfig<Options, Storage>' requires 2 type argument(s).",
    );
    expect(residual).toEqual([]);
  });

  it('parses the real pinned diagnostics out of real tsc output', () => {
    const real = asDiagnostics(PINS)
      .map(
        (pin: Diagnostic, index: number) =>
          `${pin.file}(${6934 + index},28): error ${pin.code}: ${pin.message}`,
      )
      .join('\n');

    const result = reconcile(partitionOutput(real).diagnostics, PINS);

    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('finds nothing in output that carries no diagnostics', () => {
    expect(partitionOutput('').diagnostics).toEqual([]);
    expect(partitionOutput('').residual).toEqual([]);
  });

  it('collects a global diagnostic with no file prefix as residual rather than dropping it', () => {
    const { diagnostics, residual } = partitionOutput(
      "error TS5058: The specified path does not exist: 'tsconfig.check.json'.\n",
    );

    expect(diagnostics).toEqual([]);
    expect(residual).toEqual([
      "error TS5058: The specified path does not exist: 'tsconfig.check.json'.",
    ]);
  });

  it('treats a trailing summary line as unreadable residual, since --pretty false emits none', () => {
    const { diagnostics, residual } = partitionOutput(
      'dist/index.d.mts(1,1): error TS1005: Oops.\nFound 1 error in dist/index.d.mts:1\n',
    );

    expect(diagnostics).toHaveLength(1);
    expect(residual).toEqual(['Found 1 error in dist/index.d.mts:1']);
  });
});

describe('refusing to report a pass on a run this check could not read', () => {
  const clean = { status: 0, signal: null, diagnostics: [], residual: [] };
  const oneDiagnostic = [{ file: 'dist/index.d.mts', line: 1, code: 'TS2314', message: 'x' }];

  it('accepts a clean run', () => {
    expect(classifyRun(clean)).toBeNull();
  });

  it('accepts a run whose exit code and parsed diagnostics agree', () => {
    expect(classifyRun({ ...clean, status: 2, diagnostics: oneDiagnostic })).toBeNull();
  });

  it('refuses a crash whose output parses to nothing, rather than calling every pin stale', () => {
    const reason = classifyRun({
      ...clean,
      status: 1,
      residual: ["error TS5058: The specified path does not exist: 'tsconfig.check.json'."],
    });

    expect(reason).toContain('cannot read as diagnostics');
  });

  it('refuses a run killed by a signal', () => {
    expect(classifyRun({ ...clean, signal: 'SIGKILL' })).toContain('SIGKILL');
  });

  it('refuses a non-zero exit that produced no diagnostics at all', () => {
    expect(classifyRun({ ...clean, status: 1 })).toContain('disagree');
  });

  it('refuses a zero exit that somehow produced diagnostics', () => {
    expect(classifyRun({ ...clean, status: 0, diagnostics: oneDiagnostic })).toContain('disagree');
  });
});

describe('published surface fences', () => {
  const declarationWith = (exportLine: string, body = 'declare const a: string;\n') =>
    `${body}${exportLine}\n`;

  it('reads the exported names, stripping the type modifier and following an alias', () => {
    const surface = readPublishedSurface(
      declarationWith('export { ALL_EDITOR_IDS, type EditorId, redactSecrets as redactContent };'),
    );

    expect([...surface.exported].sort()).toEqual(['ALL_EDITOR_IDS', 'EditorId', 'redactContent']);
    expect(surface.namedExportBlocks).toBe(1);
  });

  it('reads the real baseline symbol set out of a real export statement', () => {
    const surface = readPublishedSurface(
      declarationWith(exportStatement(BASELINE.exportedSymbols)),
    );

    expect(checkSurface(surface, BASELINE)).toEqual([]);
  });

  it('names every baseline symbol the published file stopped exporting', () => {
    const kept = BASELINE.exportedSymbols.slice(1);
    const violations = checkSurface(
      readPublishedSurface(declarationWith(exportStatement(kept))),
      BASELINE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(BASELINE.exportedSymbols[0]);
    expect(violations[0]).toContain(`1 of the ${BASELINE.exportedSymbols.length}`);
  });

  it('accepts a surface that adds symbols, since growth is not a consumer break', () => {
    const grown = [...BASELINE.exportedSymbols, 'somethingBrandNew'];

    expect(
      checkSurface(readPublishedSurface(declarationWith(exportStatement(grown))), BASELINE),
    ).toEqual([]);
  });

  it('refuses a file with no named export block rather than comparing against an empty set', () => {
    const violations = checkSurface(readPublishedSurface('declare const a: string;\n'), BASELINE);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('passes vacuously');
  });

  it('refuses a top-level star export, whose symbol set this check cannot enumerate', () => {
    const surface = readPublishedSurface(
      `export * from './sibling.js';\n${exportStatement(BASELINE.exportedSymbols)}\n`,
    );

    expect(checkSurface(surface, BASELINE).join('\n')).toContain('export *');
  });

  it('fails a published file that still references a sibling workspace package', () => {
    const surface = readPublishedSurface(
      `import type { Doc } from '@inkeep/open-knowledge-core';\n${exportStatement(BASELINE.exportedSymbols)}\n`,
    );

    expect(surface.inkeepLines).toHaveLength(1);
    expect(checkSurface(surface, BASELINE).join('\n')).toContain('not self-contained');
  });

  it('fails a surface whose any count climbed above the captured baseline', () => {
    const widened = `${'type W = any;\n'.repeat(BASELINE.anyCeiling + 1)}${exportStatement(BASELINE.exportedSymbols)}\n`;

    expect(checkSurface(readPublishedSurface(widened), BASELINE).join('\n')).toContain('above the');
  });

  it('counts any and unknown as whole words, so identifiers containing them do not register', () => {
    const surface = readPublishedSurface(
      declarationWith(
        'export { a };',
        'declare const anyway: unknownish;\ndeclare const a: any;\n',
      ),
    );

    expect(surface.anyCount).toBe(1);
    expect(surface.unknownCount).toBe(0);
  });
});

describe('the published-declaration pass condition', () => {
  const tally = [{ signature: 'dist/index.d.mts: TS2304: x', count: 1 }];

  it('passes only when all three fences are empty', () => {
    expect(isClean({ unexpected: [], missing: [], surfaceViolations: [] })).toBe(true);
  });

  it('fails on a surface violation even when the diagnostics reconcile', () => {
    expect(
      isClean({ unexpected: [], missing: [], surfaceViolations: ['a baseline export is gone'] }),
    ).toBe(false);
  });

  it('fails on an unexpected diagnostic and on a stale pin', () => {
    expect(isClean({ unexpected: tally, missing: [], surfaceViolations: [] })).toBe(false);
    expect(isClean({ unexpected: [], missing: tally, surfaceViolations: [] })).toBe(false);
  });
});

describe('triple-slash directives are dependencies, not prose', () => {
  it('keeps a reference directive in the self-containment fence but out of the counts', () => {
    const surface = readPublishedSurface('/// <reference types="@inkeep/any" />\nexport { A };\n');

    expect(surface.inkeepLines).toHaveLength(1);
    expect(surface.anyCount).toBe(0);
  });

  it('still drops an ordinary line comment from both views', () => {
    const surface = readPublishedSurface(
      '// see @inkeep/open-knowledge-core for any of this\ndeclare const a: string;\nexport { A };\n',
    );

    expect(surface.inkeepLines).toEqual([]);
    expect(surface.anyCount).toBe(0);
  });
});

describe('the any/unknown ceilings count types, not prose', () => {
  const withExport = (body: string) =>
    `${body}\nexport { ${BASELINE.exportedSymbols.join(', ')} };\n`;

  it('ignores `any` and `unknown` in comments and string literals', () => {
    const surface = readPublishedSurface(
      withExport(
        '/** any any unknown */\n// any unknown\ndeclare const u: "any unknown | any";\ndeclare const a: any;\n',
      ),
    );

    expect(surface.anyCount).toBe(1);
    expect(surface.unknownCount).toBe(0);
  });

  it('fences the unknown axis too, so a copy-paste of the any branch cannot go silent', () => {
    const widened = readPublishedSurface(
      withExport(`${'type W = unknown;\n'.repeat(BASELINE.unknownCeiling + 1)}`),
    );

    expect(checkSurface(widened, BASELINE).join(' ')).toContain('`unknown` occurs');
  });

  it('still counts a type that widened to any, so prose churn cannot mask it', () => {
    const prose = `${'/** any any any any any */\n'.repeat(BASELINE.anyCeiling)}`;
    const clean = readPublishedSurface(withExport(prose));
    const widened = readPublishedSurface(
      withExport(`${prose}${'declare const w: any;\n'.repeat(BASELINE.anyCeiling + 1)}`),
    );

    expect(checkSurface(clean, BASELINE)).toEqual([]);
    expect(checkSurface(widened, BASELINE).join(' ')).toContain('`any` occurs');
  });
});

describe('the pass condition main() routes through', () => {
  const cleanRun = { status: 0, signal: null, stdout: '', stderr: '' };
  // A live clean run carries the pinned diagnostics. `cleanRun` above has none and
  // is kept for the cases that assert on a pin going missing; the liveness floor
  // refuses an empty-pins run with no diagnostics, since nothing in it proves tsc
  // opened the declaration.
  const livePinnedRun = {
    status: 2,
    signal: null,
    stdout: asDiagnostics(PINS)
      .map(
        (entry: Diagnostic, i: number) =>
          `${entry.file}(${100 + i},1): error ${entry.code}: ${entry.message}`,
      )
      .join('\n'),
    stderr: '',
  };
  const declaration = (symbols: string[]) =>
    `declare const x: string;\nexport { ${symbols.join(', ')} };\n`;

  it('reports success only when the diagnostics reconcile and the surface holds', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: livePinnedRun,
      pins: PINS,
      baseline: BASELINE,
    });

    expect(result.code).toBe(0);
    expect(result.out.join(' ')).toContain('keeps the published surface');
  });

  it('fails on a dropped baseline export even though tsc reported only the pinned artifacts', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols.slice(1)),
      run: livePinnedRun,
      pins: PINS,
      baseline: BASELINE,
    });

    expect(result.code).toBe(1);
    expect(result.surfaceViolations.join(' ')).toContain('baseline exported symbols are gone');
  });

  it('refuses rather than passing when tsc was killed before it reported', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
      pins: [],
      baseline: BASELINE,
    });

    expect(result.code).toBe(1);
    expect(result.unreadable).toContain('SIGKILL');
    expect(result.missing).toEqual([]);
  });

  it('refuses rather than passing when tsc output it could not read', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: { status: 1, signal: null, stdout: 'error TS5058: no such project.\n', stderr: '' },
      pins: [],
      baseline: BASELINE,
    });

    expect(result.code).toBe(1);
    expect(result.unreadable).toContain('cannot read as diagnostics');
  });

  it('reports a pin that stopped appearing instead of passing on a clean run', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: cleanRun,
      pins: [
        {
          origin: 'zod',
          mechanism: 'variance cast',
          file: 'dist/index.d.mts',
          code: 'TS2636',
          message: 'Gone.',
        },
      ],
      baseline: BASELINE,
    });

    expect(result.code).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.signature).toContain('TS2636');
    expect(result.err.join('\n')).toContain('add a positive liveness assertion in the same change');
  });

  it('does not claim the surface changed when only the diagnostics failed', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: {
        status: 1,
        signal: null,
        stdout: "dist/index.d.mts(1,1): error TS2304: Cannot find name 'Ghost'.\n",
        stderr: '',
      },
      pins: [],
      baseline: BASELINE,
    });

    expect(result.err[0]).toContain('did not type-check as expected');
    expect(result.err[0]).not.toContain('surface changed');
  });

  it('fails on an unexpected diagnostic even though the surface holds', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: declaration(BASELINE.exportedSymbols),
      run: {
        status: 1,
        signal: null,
        stdout: "dist/index.d.mts(1,1): error TS2304: Cannot find name 'Ghost'.\n",
        stderr: '',
      },
      pins: [],
      baseline: BASELINE,
    });

    expect(result.code).toBe(1);
    expect(result.unexpected).toHaveLength(1);
  });
});

describe('the ceilings, the fingerprint and the token stream stay one number', () => {
  const evidence = join(
    import.meta.dirname,
    '../../../specs/2026-09-02-typescript-7-toolchain-upgrade/evidence/dts-baseline-5.9.3',
  );
  const tokensPath = join(evidence, 'index.tokens.txt');
  const specsRoot = join(import.meta.dirname, '../../../specs');

  it.skipIf(!existsSync(specsRoot))(
    'derives both ceilings from the committed 5.9.3 token stream',
    () => {
      expect(
        existsSync(tokensPath),
        `${tokensPath} is gone, so nothing ties anyCeiling/unknownCeiling to a capture`,
      ).toBe(true);
      const tokens = readFileSync(tokensPath, 'utf8').split('\n');
      const count = (word: string) => tokens.filter((token) => token === word).length;
      const fingerprint = JSON.parse(
        readFileSync(join(evidence, 'index.fingerprint.json'), 'utf8'),
      ) as Record<string, number>;

      expect(count('any')).toBe(BASELINE.anyCeiling);
      expect(count('unknown')).toBe(BASELINE.unknownCeiling);
      expect(fingerprint.any_tokens).toBe(BASELINE.anyCeiling);
      expect(fingerprint.unknown_tokens).toBe(BASELINE.unknownCeiling);
    },
  );
});

describe('checkProjectFences', () => {
  const sound = {
    compilerOptions: { skipLibCheck: false, customConditions: [] },
    files: ['dist/index.d.mts'],
  };
  const fence = (value: unknown) => checkProjectFences({ ok: true, value });

  it('accepts a project that disables skipLibCheck and lists the declaration', () => {
    expect(fence(sound)).toEqual([]);
  });

  it('accepts the tsconfig.check.json this package actually ships', () => {
    const onDisk = readJsoncOrError(join(import.meta.dirname, '..', 'tsconfig.check.json'));

    expect(onDisk.ok).toBe(true);
    expect(checkProjectFences(onDisk)).toEqual([]);
  });

  it('separates a project that is absent from one that is malformed', () => {
    const [absent] = checkProjectFences({ ok: false, code: 'ENOENT', reason: 'gone' });
    expect(absent).toContain('does not exist');

    const [malformed] = checkProjectFences({
      ok: false,
      code: 'EPARSE',
      reason: 'malformed rather than merely commented',
    });
    expect(malformed).toContain('could not be read');
    expect(malformed).toContain('malformed rather than merely commented');
  });

  it('reads a project that carries JSONC comments as the fences it declares', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-project-fences-'));
    try {
      const file = join(dir, 'tsconfig.check.json');
      writeFileSync(
        file,
        '{\n  // the base sets skipLibCheck true\n  "compilerOptions": { "skipLibCheck": false, "customConditions": [] },\n  "files": ["dist/index.d.mts"],\n}\n',
      );

      expect(checkProjectFences(readJsoncOrError(file))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a project that leaves skipLibCheck at the base value', () => {
    const [problem] = fence({ ...sound, compilerOptions: { customConditions: [] } });
    expect(problem).toContain('skipLibCheck: false');
    expect(problem).toContain('would pass without reading the published surface');
  });

  it('rejects a project that fences a file other than the published declaration', () => {
    const [problem] = fence({ ...sound, files: [] });
    expect(problem).toContain('does not list dist/index.d.mts');
  });

  it('rejects a project that leaves the base source condition in place', () => {
    const [problem] = fence({ ...sound, compilerOptions: { skipLibCheck: false } });
    expect(problem).toContain('does not reset `customConditions` to []');
    expect(problem).toContain('The "standalone" claim in the success line rests on that reset');
  });

  it('reports every broken fence rather than stopping at the first', () => {
    const problems = fence({ compilerOptions: {}, files: [] });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('skipLibCheck: false');
    expect(problems[1]).toContain('does not list dist/index.d.mts');
    expect(problems[2]).toContain('does not reset `customConditions` to []');
  });
});

describe('the liveness floor under evaluate', () => {
  it('refuses a run with no diagnostics and no pins, which proves nothing was read', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: 'declare const x: string;\nexport { x };\n',
      run: { status: 0, signal: null, stdout: '', stderr: '' },
      pins: [],
      baseline: { exportedSymbols: [], anyCeiling: 0, unknownCeiling: 0, capturedFrom: 'test' },
    });

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain('verified nothing');
    expect(result.unreadable).toContain('no artifact is pinned');
  });

  it('carries the surface diagnosis it computed rather than discarding it at the floor', () => {
    const result = evaluate({
      root: '/tree',
      declarationText: 'declare const x: string;\nexport { x };\n',
      run: { status: 0, signal: null, stdout: '', stderr: '' },
      pins: [],
      baseline: {
        exportedSymbols: ['x', 'y'],
        anyCeiling: 0,
        unknownCeiling: 0,
        capturedFrom: 'test',
      },
    });

    expect(result.code).toBe(1);
    expect(result.surfaceViolations).toHaveLength(1);
    expect(result.err.join(' ')).toContain('baseline exported symbols are gone');
  });
});

describe('the success line names the tree it checked', () => {
  const livePinnedRun = {
    status: 2,
    signal: null,
    stdout: asDiagnostics(PINS)
      .map(
        (entry: Diagnostic, i: number) =>
          `${entry.file}(${100 + i},1): error ${entry.code}: ${entry.message}`,
      )
      .join('\n'),
    stderr: '',
  };
  const cleanArgs = () => ({
    root: '/tree',
    declarationText: `declare const x: string;\nexport { ${BASELINE.exportedSymbols.join(', ')} };\n`,
    run: livePinnedRun,
    pins: PINS,
    baseline: BASELINE,
  });

  it('prints no provenance marker when no source is declared', () => {
    const result = evaluate(cleanArgs());
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(
      /^check:dts: OK at \/tree — dist\/index\.d\.mts type-checks standalone/,
    );
    expect(result.out[0]).not.toContain('[from');
  });

  it('prints the root and the variable it came from when a source is declared', () => {
    const result = evaluate({ ...cleanArgs(), rootSource: 'OK_PUBLISHED_DTS_ROOT' });
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^check:dts: OK at \/tree \[from OK_PUBLISHED_DTS_ROOT\] — /);
  });
});

describe('the refusals main() reaches before it ever runs tsc', () => {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const PACKAGE_ROOT = join(SCRIPT_DIR, '..');

  const run = (root: string) =>
    spawnSync('node', [join(SCRIPT_DIR, 'check-published-dts.mjs')], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: { ...process.env, OK_PUBLISHED_DTS_ROOT: root },
    });

  const fixtureRoot = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'check-published-dts-'));
    for (const [relative, body] of Object.entries(files)) {
      const file = join(root, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    return root;
  };

  const refusalCase = (files: Record<string, string>, expected: (root: string) => string[]) => {
    const root = fixtureRoot(files);
    try {
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      for (const fragment of expected(root)) expect(result.stderr).toContain(fragment);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('refuses when the published declaration has not been built', () => {
    refusalCase({}, (root) => [
      join(root, 'dist/index.d.mts'),
      'does not exist',
      'pnpm run build:cli',
    ]);
  });

  it('refuses when no tsc sits beside the package rather than falling through to a global one', () => {
    refusalCase({ 'dist/index.d.mts': 'export {};\n' }, (root) => [
      `no tsc at ${join(root, 'node_modules', '.bin')}`,
      'falling through to a machine-global tsc',
    ]);
  });

  it('refuses when the project it would type-check under no longer fences what it claims', () => {
    refusalCase(
      {
        'dist/index.d.mts': 'export {};\n',
        'node_modules/.bin/tsc': '#!/bin/sh\nexit 0\n',
        'tsconfig.check.json': JSON.stringify({ compilerOptions: { skipLibCheck: true } }),
      },
      () => [
        'no longer fences what the success line claims',
        'does not set `skipLibCheck: false`',
        'does not list dist/index.d.mts in `files`',
        'does not reset `customConditions` to []',
      ],
    );
  });
});
