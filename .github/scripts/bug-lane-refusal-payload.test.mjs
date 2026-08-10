import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildSlackPayload,
  changedJsonKeys,
  classifyConflictPath,
  classifyRefs,
  describeRefusal,
  INERT_JSON_KEYS,
  optionsFor,
  parseArgs,
} from './bug-lane-refusal-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bugLane = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'bug-lane.yml'), 'utf8');

/** A private manifest whose only fix-side change is the Playwright subset. */
const appManifest = (e2e) =>
  JSON.stringify({
    name: '@inkeep/open-knowledge-app',
    private: true,
    scripts: { test: 'vitest run', 'test:e2e': `playwright test ${e2e}` },
  });

describe('changedJsonKeys', () => {
  test('reports dotted leaf paths, not subtrees', () => {
    expect(changedJsonKeys({ scripts: { a: '1', b: '2' } }, { scripts: { a: '1', b: '3' } })).toEqual(
      ['scripts.b'],
    );
  });

  test('catches added and removed leaves, not just modified ones', () => {
    expect(changedJsonKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedJsonKeys({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  test('does not confuse a stringified value with a structural change', () => {
    expect(changedJsonKeys({ a: '1' }, { a: 1 })).toEqual(['a']);
  });
});

describe('classifyConflictPath', () => {
  // The incident this exists for: a bug fix appended one Playwright spec to
  // the CI subset, an unrelated feature had appended six since the stable, and
  // the whole point release was refused over a line that does not ship.
  test('the e2e-subset append is inert', () => {
    const got = classifyConflictPath({
      path: 'packages/app/package.json',
      before: appManifest('a.e2e.ts b.e2e.ts'),
      after: appManifest('a.e2e.ts b.e2e.ts preview-tab-promotion.e2e.ts'),
    });
    expect(got.inert).toBe(true);
    expect(got.detail).toContain('scripts.test:e2e');
    expect(got.detail).toMatch(/does not ship/i);
  });

  test('a published manifest is never inert, whatever key moved', () => {
    const pub = (e2e) =>
      JSON.stringify({ name: '@inkeep/open-knowledge', scripts: { 'test:e2e': e2e } });
    const got = classifyConflictPath({ path: 'packages/cli/package.json', before: pub('a'), after: pub('b') });
    expect(got.inert).toBe(false);
    expect(got.detail).toMatch(/published/);
  });

  test('a sibling key riding along disqualifies the whole path', () => {
    const before = appManifest('a.e2e.ts');
    const after = JSON.stringify({
      name: '@inkeep/open-knowledge-app',
      private: true,
      scripts: { test: 'vitest run', 'test:e2e': 'playwright test a.e2e.ts b.e2e.ts' },
      dependencies: { react: '19.2.0' },
    });
    const got = classifyConflictPath({ path: 'packages/app/package.json', before, after });
    expect(got.inert).toBe(false);
    expect(got.detail).toContain('dependencies.react');
  });

  // `scripts.test` IS the tier the lane runs to verify the synthetic tree, so
  // treating it like its `test:e2e` sibling would let a drifted verification
  // command be reported as harmless.
  test('scripts.test is not inert even though test:e2e is', () => {
    expect(INERT_JSON_KEYS.has('scripts.test')).toBe(false);
    const after = JSON.stringify({
      name: '@inkeep/open-knowledge-app',
      private: true,
      scripts: { test: 'vitest run --changed', 'test:e2e': 'playwright test a.e2e.ts' },
    });
    const got = classifyConflictPath({
      path: 'packages/app/package.json',
      before: appManifest('a.e2e.ts'),
      after,
    });
    expect(got.inert).toBe(false);
    expect(got.detail).toContain('scripts.test');
  });

  test.each([
    ['a source file', 'packages/app/src/components/FileTree.tsx', 'x', 'y'],
    ['a lockfile', 'pnpm-lock.yaml', 'a', 'b'],
    ['a workflow', '.github/workflows/release.yml', 'a', 'b'],
  ])('fails closed on %s', (_label, path, before, after) => {
    expect(classifyConflictPath({ path, before, after }).inert).toBe(false);
  });

  test('fails closed on unparseable JSON rather than assuming', () => {
    const got = classifyConflictPath({
      path: 'packages/app/package.json',
      before: '{not json',
      after: appManifest('a.e2e.ts'),
    });
    expect(got.inert).toBe(false);
    expect(got.detail).toMatch(/unreadable/);
  });

  test('a path the fix never changed is not called harmless', () => {
    const same = appManifest('a.e2e.ts');
    const got = classifyConflictPath({ path: 'packages/app/package.json', before: same, after: same });
    expect(got.inert).toBe(false);
    expect(got.detail).toMatch(/without the fix changing it/);
  });
});

describe('classifyRefs', () => {
  const gitShow = (blobs) => (rev, path) => blobs[`${rev}:${path}`] ?? null;

  test('a ref is inert only when every one of its paths is', () => {
    const blobs = {
      'abc^:packages/app/package.json': appManifest('a.e2e.ts'),
      'abc:packages/app/package.json': appManifest('a.e2e.ts b.e2e.ts'),
      'abc^:packages/app/src/x.ts': 'a',
      'abc:packages/app/src/x.ts': 'b',
    };
    const [onlyConfig] = classifyRefs(
      [{ ref: 'abc', conflicts: ['packages/app/package.json'] }],
      gitShow(blobs),
    );
    expect(onlyConfig.inert).toBe(true);

    const [withSource] = classifyRefs(
      [{ ref: 'abc', conflicts: ['packages/app/package.json', 'packages/app/src/x.ts'] }],
      gitShow(blobs),
    );
    expect(withSource.inert).toBe(false);
  });

  test('an unreadable blob fails closed instead of throwing', () => {
    const [entry] = classifyRefs([{ ref: 'abc', conflicts: ['gone.json'] }], gitShow({}));
    expect(entry.inert).toBe(false);
    expect(entry.files[0].detail).toMatch(/unreadable/);
  });

  test('a ref with no recorded conflicts is not vacuously inert', () => {
    expect(classifyRefs([{ ref: 'abc', conflicts: [] }], gitShow({}))[0].inert).toBe(false);
  });
});

describe('describeRefusal', () => {
  const inert = [{ ref: 'a', inert: true, files: [] }];
  const behavioral = [{ ref: 'a', inert: false, files: [] }];

  test('the three refusal classes read differently at a glance', () => {
    const h = (args) => describeRefusal(args).headline;
    const drift = h({ verdict: 'conflict', refs: inert });
    const real = h({ verdict: 'conflict', refs: behavioral });
    const red = h({ verdict: 'fail', refs: [] });
    expect(new Set([drift, real, red]).size).toBe(3);
    expect(drift).toMatch(/config drift, not by the fix/);
    expect(real).toMatch(/does not apply/);
  });

  test('one behavior-carrying ref in a mixed batch picks the severe headline', () => {
    expect(describeRefusal({ verdict: 'conflict', refs: [...inert, ...behavioral] }).headline).toMatch(
      /does not apply/,
    );
  });
});

describe('optionsFor', () => {
  test('the inert case never points at resolve_paths, which would refuse', () => {
    const opts = optionsFor({ verdict: 'conflict', refs: [{ ref: 'a', inert: true, files: [] }] });
    expect(opts.join('\n')).not.toMatch(/-f resolve_paths=/);
    expect(opts.join('\n')).toMatch(/allowlist is code/);
  });

  test('inert and behavioral give different advice', () => {
    const a = optionsFor({ verdict: 'conflict', refs: [{ ref: 'x', inert: true, files: [] }] });
    const b = optionsFor({ verdict: 'conflict', refs: [{ ref: 'x', inert: false, files: [] }] });
    expect(a).not.toEqual(b);
    expect(b.join('\n')).toMatch(/smaller self-contained commit/);
  });
});

describe('buildSlackPayload', () => {
  const refs = [
    {
      ref: '103e961036fc053824b98f1e44a4616d6d4d9d87',
      tickets: ['PRD-7835'],
      totalFiles: 28,
      inert: true,
      files: [{ path: 'packages/app/package.json', inert: true, detail: 'scripts.test:e2e only' }],
    },
  ];

  test('names the ticket, the path, the verdict and what applied cleanly', () => {
    const body = buildSlackPayload({
      verdict: 'conflict',
      stable: 'v0.48.9',
      refs,
      runUrl: 'https://example.test/run/1',
    }).blocks[1].text.text;
    expect(body).toContain('PRD-7835');
    expect(body).toContain('packages/app/package.json');
    expect(body).toContain('v0.48.9');
    expect(body).toContain('27 other files in the commit applied cleanly');
  });

  test('keeps the silence-is-deliberate note', () => {
    const body = buildSlackPayload({ verdict: 'conflict', stable: 'v1', refs, runUrl: '' }).blocks[1]
      .text.text;
    expect(body).toMatch(/Further identical refusals stay silent/);
  });

  test('a commit subject containing quotes cannot corrupt the payload', () => {
    const hostile = [
      { ...refs[0], tickets: ['"}, {"type":"section","text":"pwned'], files: refs[0].files },
    ];
    const payload = buildSlackPayload({ verdict: 'conflict', stable: 'v1', refs: hostile, runUrl: '' });
    expect(JSON.parse(JSON.stringify(payload)).blocks).toHaveLength(2);
  });

  test('caps a large batch instead of blowing Slack’s block limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ref: `${i}`.repeat(12),
      tickets: [],
      totalFiles: 2,
      inert: false,
      files: Array.from({ length: 20 }, (_, j) => ({
        path: `p${j}.ts`,
        inert: false,
        detail: 'carries behavior',
      })),
    }));
    const body = buildSlackPayload({ verdict: 'conflict', stable: 'v1', refs: many, runUrl: '' })
      .blocks[1].text.text;
    expect(body).toMatch(/and 7 more ref\(s\)/);
    expect(body).toMatch(/and 12 more/);
    expect(body.length).toBeLessThan(3000);
  });
});

describe('parseArgs', () => {
  test('requires --input', () => {
    expect(() => parseArgs(['node', 'x'])).toThrow(/--input is required/);
  });

  test('defaults a missing refs array rather than throwing', () => {
    expect(parseArgs(['node', 'x', '--input', '{"verdict":"fail"}']).refs).toEqual([]);
  });
});

describe('workflow wiring', () => {
  /** Exact bounds of a step: its `- name:` up to the next sibling step. */
  const step = (name) => {
    const rest = bugLane.slice(bugLane.indexOf(`- name: ${name}`));
    const end = rest.indexOf('\n      - name: ');
    return end === -1 ? rest : rest.slice(0, end);
  };

  /**
   * The step's executable shell, with whole-line comments removed. Assertions
   * about what the shell DOES must not be satisfiable — or broken — by prose
   * that quotes the very form it warns against.
   */
  const shellOf = (name) =>
    step(name)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  test('the verify step records conflicted paths before aborting the pick', () => {
    const verify = step('Verify the synthetic tree');
    const conflictCapture = verify.indexOf('--diff-filter=U');
    const abort = verify.indexOf('cherry-pick --abort');
    expect(conflictCapture).toBeGreaterThan(-1);
    // An abort clears the index, so capturing after it yields an empty list and
    // the page silently loses the only datum that makes it actionable.
    expect(conflictCapture).toBeLessThan(abort);
  });

  test('the refusal page builds its body through this script', () => {
    expect(step('Page on a refusal')).toContain('bug-lane-refusal-payload.mjs');
  });

  // `${V:-{\}}` expands to a LITERAL `{\}` — a brace in a parameter-expansion
  // default is not escapable there. jq --argjson then refuses, and the enriched
  // page degrades to the plain fallback on every single run, with nothing in
  // the log saying the enrichment never happened.
  test('the page does not default a JSON var with a brace expansion', () => {
    expect(shellOf('Page on a refusal')).not.toMatch(/\$\{[A-Za-z_]+:-\{/);
  });

  // Steps share one workspace, and verify leaves it detached at the stable tag
  // — which predates this script, so it is simply not on disk by the time the
  // page runs. Without a restore the page degrades to the fallback forever,
  // and nothing in the log says the enrichment never happened.
  test('the page restores the lane scripts the detached tree dropped', () => {
    const shell = shellOf('Page on a refusal');
    const restore = shell.indexOf('git checkout "$GITHUB_SHA"');
    const invoke = shell.indexOf('bug-lane-refusal-payload.mjs');
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(invoke);
  });

  // `git checkout <ref> -- a b` is atomic: one path missing at that ref aborts
  // the whole restore, so combining them would let an unrelated rename leave
  // the page silently degraded. Asserted as the shape it must have — one
  // single-token pathspec, driven by a loop — rather than by trying to exclude
  // every way two could be written.
  test('the restore names one path at a time', () => {
    expect(shellOf('Page on a refusal')).toMatch(
      /for p in [^\n]*\n\s*git checkout "\$GITHUB_SHA" -- "\$p"/,
    );
  });

  test('the lane still never authorizes conflict resolution when dispatching', () => {
    expect(bugLane).not.toContain('resolve_paths');
  });
});
