import { readdirSync, readFileSync } from 'node:fs';
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
// The lane is two workflows since the 2026-08-21 split: bug-lane.yml evaluates
// and hands off, bug-lane-verify.yml does the picking, paging and dispatching.
// Every step this file asserts on lives in the verify half — assert against the
// file that actually RUNS the step, so a step drifting back across the boundary
// fails here rather than passing on a concatenation.
const bugLaneVerify = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'bug-lane-verify.yml'),
  'utf8',
);

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
  // Production-shaped. `classifyRefs` derives `inert` as
  // `files.length > 0 && files.every(...)`, so a ref carrying the flag ALWAYS
  // carries the paths it was derived from; an empty `files` is a distinct
  // state (the pick failed without conflicting) and gets its own class below.
  const inert = [
    { ref: 'a', inert: true, files: [{ path: 'packages/app/package.json', inert: true, detail: 'test:e2e only' }] },
  ];
  const behavioral = [
    { ref: 'a', inert: false, files: [{ path: 'packages/server/src/boot.ts', inert: false, detail: 'carries behavior' }] },
  ];
  const noPaths = [{ ref: 'a', inert: false, totalFiles: 37, files: [] }];

  test('the four refusal classes read differently at a glance', () => {
    const h = (args) => describeRefusal(args).headline;
    const drift = h({ verdict: 'conflict', refs: inert });
    const real = h({ verdict: 'conflict', refs: behavioral });
    const red = h({ verdict: 'fail', refs: [] });
    const unknown = h({ verdict: 'conflict', refs: noPaths });
    expect(new Set([drift, real, red, unknown]).size).toBe(4);
    expect(drift).toMatch(/config drift, not by the fix/);
    expect(real).toMatch(/does not apply/);
  });

  test('one behavior-carrying ref in a mixed batch picks the severe headline', () => {
    expect(describeRefusal({ verdict: 'conflict', refs: [...inert, ...behavioral] }).headline).toMatch(
      /does not apply/,
    );
  });

  // The shape that shipped a false alarm: a pick that applied EMPTY because
  // the stable already contained the fix exited non-zero with no conflicting
  // path, and the severe branch asserted a behavior-carrying collision it had
  // no evidence for — telling the reader the fix depended on later work when
  // it was already released.
  test('no recorded conflicting path never claims a behavior-carrying collision', () => {
    const { headline, meaning } = describeRefusal({ verdict: 'conflict', refs: noPaths });
    expect(headline).not.toMatch(/does not apply to the current stable/);
    expect(meaning).not.toMatch(/carries behavior/);
    expect(meaning).toMatch(/no conflicting file/);
  });

  // A batch where one ref genuinely collided must still report the severe
  // case; the no-path class is only for a batch with no evidence at all.
  test('a mixed batch with real paths keeps the severe headline', () => {
    expect(describeRefusal({ verdict: 'conflict', refs: [...noPaths, ...behavioral] }).headline).toMatch(
      /does not apply/,
    );
  });
});

describe('optionsFor', () => {
  const withPath = (inertFlag) => [
    { ref: 'x', inert: inertFlag, files: [{ path: 'p/package.json', inert: inertFlag, detail: 'd' }] },
  ];

  test('the inert case never points at resolve_paths, which would refuse', () => {
    const opts = optionsFor({ verdict: 'conflict', refs: withPath(true) });
    expect(opts.join('\n')).not.toMatch(/-f resolve_paths=/);
    expect(opts.join('\n')).toMatch(/allowlist is code/);
  });

  test('inert and behavioral give different advice', () => {
    const a = optionsFor({ verdict: 'conflict', refs: withPath(true) });
    const b = optionsFor({ verdict: 'conflict', refs: withPath(false) });
    expect(a).not.toEqual(b);
    expect(b.join('\n')).toMatch(/smaller self-contained commit/);
  });

  // Without evidence the advice must not send someone to hand-cut a release:
  // the likeliest cause of a pathless failure is that the fix already shipped.
  test('no recorded path sends the reader to the log, not to a hand-cut release', () => {
    const opts = optionsFor({ verdict: 'conflict', refs: [{ ref: 'x', inert: false, files: [] }] }).join('\n');
    expect(opts).not.toMatch(/smaller self-contained commit/);
    expect(opts).toMatch(/run log/);
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

  // The verbatim shape of the page that went out for PRD-7310 over v0.50.2:
  // 37 files, none conflicting, because the stable already shipped the fix.
  // It rendered "conflicted in 0 files:" with nothing under it, immediately
  // followed by "37 other files applied cleanly" — a stated conflict with no
  // evidence, contradicted by its own next line.
  test('a pathless failure renders no empty conflict list and no phantom count', () => {
    const body = buildSlackPayload({
      verdict: 'conflict',
      stable: 'v0.50.2',
      refs: [{ ref: '4cef9c5a587dc26ea4bcb5fe2ab134a1fa8ec00d', tickets: ['PRD-7310'], totalFiles: 37, inert: false, files: [] }],
      runUrl: '',
    }).blocks[1].text.text;
    expect(body).not.toContain('conflicted in 0 files');
    expect(body).not.toContain('37 other files');
    expect(body).toContain('PRD-7310');
    expect(body).toContain('no conflicting file');
    expect(body).toContain('all 37 files in the commit applied cleanly');
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
  /**
   * Exact bounds of a step: its `- name:` up to the next sibling step.
   *
   * Throws on a missing name rather than returning a degenerate slice. An
   * unguarded `indexOf` yields -1, `slice(-1)` yields the file's last
   * character, and every `not.toContain` / `not.toMatch` assertion below then
   * passes against that one character — so a renamed or relocated step turns
   * its own coverage green instead of red. The sibling helper in
   * release-cascade-shape.test.mjs guards the same way, for the same reason.
   */
  const step = (name) => {
    const start = bugLaneVerify.indexOf(`- name: ${name}`);
    if (start === -1) throw new Error(`bug-lane-verify.yml has no step named ${name}`);
    const rest = bugLaneVerify.slice(start);
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

  // A pick onto a stable that already contains the fix exits non-zero with no
  // conflicting path. Treated as a conflict it pages a refusal claiming the
  // fix depends on later work — the opposite of the truth — so it must be
  // classified BEFORE the conflict bookkeeping runs.
  test('the verify step separates an empty pick from a conflict', () => {
    const verify = shellOf('Verify the synthetic tree');
    const emptyGuard = verify.indexOf('git diff --quiet HEAD');
    const recordConflict = verify.indexOf('CONFLICT_JSON=$(jq');
    expect(emptyGuard).toBeGreaterThan(-1);
    expect(recordConflict).toBeGreaterThan(-1);
    expect(emptyGuard).toBeLessThan(recordConflict);
    expect(verify).toContain('already-in-stable');
  });

  // The guarantee the whole change rests on: an all-already tick is silent
  // BY CONSTRUCTION, because the paging chain only ever fires on the two
  // verdicts that represent a real question for a human.
  test('only conflict and fail can reach the pager', () => {
    const gate = step('Refusal signature');
    const verdicts = [...gate.matchAll(/verdict == '([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(verdicts)).toEqual(new Set(['conflict', 'fail']));
    expect(verdicts).not.toContain('already-in-stable');
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
    // Both halves: the dispatch lives in the verify workflow, but this is a
    // fail-closed assertion about the LANE, and the evaluator gained its own
    // `gh workflow run` in the split. Checking only one half would let the
    // other acquire the flag silently.
    expect(bugLane).not.toContain('resolve_paths');
    expect(bugLaneVerify).not.toContain('resolve_paths');
  });

  // Pins the guard itself. Every other call site names a step that exists, so
  // the throw branch is otherwise dead code — and a future edit that dropped it
  // (a merge conflict, a simplification) would return this whole describe to
  // passing vacuously with nothing going red. Verifying it by hand once proves
  // it works today; only this proves it still does.
  test('step() throws on a missing name instead of returning a degenerate slice', () => {
    expect(() => step('This step does not exist')).toThrow(/has no step named/);
  });

  /**
   * Every `run:` body in a workflow, block-scalar and inline forms both.
   *
   * Scoped to `run:` rather than matching `${{ inputs.` line-shapes anywhere,
   * because the rule is about reaching a SHELL. A `with:` parameter
   * (`ref: ${{ inputs.stable }}`) is legitimate and a line-shape filter would
   * red-flag it, teaching whoever trips it that the rule is arbitrary.
   */
  const runBodies = (yaml) => {
    const lines = yaml.split('\n');
    const bodies = [];
    for (let i = 0; i < lines.length; i++) {
      const block = /^(\s*)run: [|>]/.exec(lines[i]);
      if (block) {
        const indent = block[1].length;
        const body = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') {
            body.push(lines[j]);
            continue;
          }
          if (lines[j].length - lines[j].trimStart().length <= indent) break;
          body.push(lines[j]);
        }
        bodies.push(body.join('\n'));
        continue;
      }
      const inline = /^\s*run: (?![|>]\s*$)(.+)$/.exec(lines[i]);
      if (inline) bodies.push(inline[1]);
    }
    return bodies;
  };

  // THE RATCHET for the env-only convention. Without it the rule lives in a
  // comment: reverting the `Refuse an empty batch` env block to direct
  // `${{ inputs.* }}` splicing left all 1200 tests in this project green, which
  // is how that defect shipped in the first place despite two reviewers naming
  // it. `${{ }}` is substituted as raw text before the shell parses, so a
  // dispatch value carrying `$(...)` executes in a job holding GITHUB_TOKEN and
  // the Slack webhook secrets.
  //
  // Scoped to `inputs.` — the untrusted surface. `steps.*.outputs.*` splicing
  // is deliberately NOT banned: those values are produced by the workflow
  // itself, so a blanket ban would be a materially different and much churnier
  // rule than the one the convention comments actually state.
  test('dispatch inputs reach the shell only through env, never `${{ }}` splicing', () => {
    // Every workflow, not just the lane's two: the convention comment claims to
    // govern publish-linux-repo.yml and point-release.yml as well, and a rule
    // enforced only where it was written is how the next copy escapes it.
    const dir = join(REPO_ROOT, '.github', 'workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length, 'no workflows found to scan').toBeGreaterThan(0);

    for (const file of files) {
      const yaml = readFileSync(join(dir, file), 'utf8');
      const bodies = runBodies(yaml);
      // Catches a walker that SKIPS a block. It cannot catch one that captures
      // a block and TRUNCATES it, since `declared` reads the same `run:`
      // anchor — that half is pinned directly by the walker unit test below,
      // which is the only thing that actually proves depth.
      const declared = yaml.split('\n').filter((l) => /^\s*run: /.test(l)).length;
      expect(bodies.length, `${file}: walker missed a run: block`).toBe(declared);
      // Every spelling, not one literal. `${{inputs.x}}`, a two-space variant
      // and the `github.event.inputs.*` form are all equivalent to Actions and
      // all enable the identical injection — and that last form is a live idiom
      // in this very directory, so it is the likely alternate spelling rather
      // than a hypothetical one.
      const spliced = bodies.filter((b) => /\$\{\{\s*(github\.event\.)?inputs\./.test(b));
      expect(spliced, `${file}: inputs spliced into a run: body`).toEqual([]);
    }
  });

  // Pins runBodies() against a synthetic document, which is the only thing that
  // proves DEPTH. A count check compares the walker to the same `run:` anchor it
  // reads, so a walker truncated to its first line keeps the count intact and
  // the ratchet above goes quiet with a real splice sitting on line two. A
  // corpus sentinel does not close it either: the first line of these bodies is
  // the shell preamble, so a one-line capture still matches it.
  test('runBodies captures a whole block, neither truncated nor bled into the next step', () => {
    const doc = [
      'jobs:',
      '  j:',
      '    steps:',
      '      - name: one',
      '        run: |',
      '          first',
      '          second',
      '          third',
      '      - name: two',
      '        run: echo inline',
      '',
    ].join('\n');
    const bodies = runBodies(doc);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('first');
    // The assertion a truncating walker fails.
    expect(bodies[0]).toContain('third');
    // The assertion an over-capturing walker fails.
    expect(bodies[0]).not.toContain('- name: two');
    expect(bodies[1]).toBe('echo inline');
  });
});
