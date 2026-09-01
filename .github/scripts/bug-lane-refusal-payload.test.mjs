import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  actionLine,
  buildHeadline,
  buildSlackPayload,
  changedJsonKeys,
  classifyConflictPath,
  classifyRefs,
  INERT_JSON_KEYS,
  parseArgs,
  reasonPhrase,
} from './bug-lane-refusal-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bugLane = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'bug-lane.yml'), 'utf8');
const bugLaneVerify = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'bug-lane-verify.yml'),
  'utf8',
);

const appManifest = (e2e) =>
  JSON.stringify({
    name: '@inkeep/open-knowledge-app',
    private: true,
    scripts: { test: 'vitest run', 'test:e2e': `playwright test ${e2e}` },
  });

describe('changedJsonKeys', () => {
  test('reports dotted leaf paths, not subtrees', () => {
    expect(
      changedJsonKeys({ scripts: { a: '1', b: '2' } }, { scripts: { a: '1', b: '3' } }),
    ).toEqual(['scripts.b']);
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
    const got = classifyConflictPath({
      path: 'packages/cli/package.json',
      before: pub('a'),
      after: pub('b'),
    });
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
    const got = classifyConflictPath({
      path: 'packages/app/package.json',
      before: same,
      after: same,
    });
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

describe('reasonPhrase and buildHeadline', () => {
  const inert = [
    {
      ref: 'a',
      inert: true,
      files: [{ path: 'packages/app/package.json', inert: true, detail: 'test:e2e only' }],
    },
  ];
  const behavioral = [
    {
      ref: 'a',
      inert: false,
      files: [{ path: 'packages/server/src/boot.ts', inert: false, detail: 'carries behavior' }],
    },
  ];
  const noPaths = [{ ref: 'a', inert: false, totalFiles: 37, files: [] }];

  test('the reason phrase is three words or fewer', () => {
    const words = (s) => s.split(/\s+/).length;
    expect(words(reasonPhrase({ verdict: 'could-not-verify', refs: [] }))).toBeLessThanOrEqual(3);
    expect(words(reasonPhrase({ verdict: 'fail', refs: [] }))).toBeLessThanOrEqual(3);
    expect(words(reasonPhrase({ verdict: 'conflict', refs: inert }))).toBeLessThanOrEqual(3);
    expect(words(reasonPhrase({ verdict: 'conflict', refs: noPaths }))).toBeLessThanOrEqual(3);
    expect(words(reasonPhrase({ verdict: 'conflict', refs: behavioral }))).toBeLessThanOrEqual(3);
  });

  test('the four refusal classes read differently at a glance', () => {
    const r = (args) => reasonPhrase(args);
    const drift = r({ verdict: 'conflict', refs: inert });
    const real = r({ verdict: 'conflict', refs: behavioral });
    const red = r({ verdict: 'fail', refs: [] });
    const unknown = r({ verdict: 'conflict', refs: noPaths });
    expect(new Set([drift, real, red, unknown]).size).toBe(4);
    expect(drift).toMatch(/config drift/);
    expect(real).toMatch(/conflict/);
  });

  test('one behavior-carrying ref in a mixed batch picks the severe reason', () => {
    expect(reasonPhrase({ verdict: 'conflict', refs: [...inert, ...behavioral] })).toBe(
      'behavior-carrying conflict',
    );
  });

  test('no recorded conflicting path never claims a behavior-carrying collision', () => {
    expect(reasonPhrase({ verdict: 'conflict', refs: noPaths })).not.toMatch(/behavior/);
  });

  test('a mixed batch with real paths keeps the severe reason', () => {
    expect(reasonPhrase({ verdict: 'conflict', refs: [...noPaths, ...behavioral] })).toBe(
      'behavior-carrying conflict',
    );
  });

  test('the headline names the specific ref and ticket on a conflict', () => {
    const headline = buildHeadline({
      verdict: 'conflict',
      refs: [{ ref: 'abcdef1234567890', tickets: ['PRD-1'], inert: false, files: [] }],
      stable: 'v1.2.3',
    });
    expect(headline).toContain('`abcdef123` (PRD-1)');
    expect(headline).toContain('v1.2.3');
    expect(headline).toContain('No action needed');
  });

  test('a red tier or a budget blow names the batch, not a specific ref', () => {
    expect(buildHeadline({ verdict: 'fail', refs: [], stable: 'v1' })).toContain(
      'The queued fix(es)',
    );
    expect(buildHeadline({ verdict: 'could-not-verify', refs: [], stable: 'v1' })).toContain(
      'The queued fix(es)',
    );
  });

  test('the no-action sentence differs for a budget blow', () => {
    const retried = buildHeadline({ verdict: 'could-not-verify', refs: [], stable: 'v1' });
    const soaked = buildHeadline({ verdict: 'conflict', refs: inert, stable: 'v1' });
    expect(retried).toMatch(/retries this batch automatically/);
    expect(soaked).toMatch(/rides its cycle's stable/);
    expect(retried).not.toMatch(/rides its cycle's stable/);
  });
});

describe('actionLine', () => {
  const withPath = (inertFlag) => [
    {
      ref: 'x',
      inert: inertFlag,
      files: [{ path: 'p/package.json', inert: inertFlag, detail: 'd' }],
    },
  ];

  test('the inert case never points at resolve_paths, which would refuse, but still names the disqualifier', () => {
    const line = actionLine({ verdict: 'conflict', refs: withPath(true) });
    expect(line).not.toMatch(/-f resolve_paths=/);
    expect(line).toMatch(/config drift/);
    expect(line).toMatch(/resolve_paths.*does not cover this path/);
  });

  test('inert and behavioral give different advice', () => {
    const a = actionLine({ verdict: 'conflict', refs: withPath(true) });
    const b = actionLine({ verdict: 'conflict', refs: withPath(false) });
    expect(a).not.toEqual(b);
    expect(b).toMatch(/smaller self-contained commit/);
  });

  test('no recorded path sends the reader to the log, not to a hand-cut release', () => {
    const line = actionLine({ verdict: 'conflict', refs: [{ ref: 'x', inert: false, files: [] }] });
    expect(line).not.toMatch(/smaller self-contained commit/);
    expect(line).toMatch(/run/);
    expect(line).toMatch(/already be in the stable/);
  });

  test('a budget blow points at the lane’s recent runs, not at a resolution', () => {
    expect(actionLine({ verdict: 'could-not-verify', refs: [] })).toMatch(/recent runs/);
  });

  test('a red tier never renders refs-based advice, even when the dropped refs are inert', () => {
    const line = actionLine({ verdict: 'fail', refs: withPath(true) });
    expect(line).not.toMatch(/needs a human decision/);
    expect(line).not.toMatch(/config drift/);
    expect(line).not.toMatch(/smaller self-contained commit/);
    expect(line).toMatch(/stable is red on its own/);
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

  test('a red tier names the failing test instead of an empty reason', () => {
    const body = buildSlackPayload({
      verdict: 'fail',
      stable: 'v0.62.1',
      refs: [],
      runUrl: '',
      failures: [
        'src/skill-bundles.test.ts > every bundle has a SKILL.md on disk whose frontmatter name matches',
      ],
    }).blocks[0].text.text;
    expect(body).toContain('skill-bundles.test.ts');
    expect(body).toContain('not flake-class');
    expect(body).toContain('red verification');
    expect(body).not.toContain('verification timeout');
    expect(body).not.toMatch(/\*Why it refused\*\n\n/);
    expect(body).toContain('the stable is red on its own');
    expect(body).toContain('check it against the fixes');
    expect(body).toContain('depends on later work');
  });

  test('a red tier with dropped refs still accounts for the drops, without advising on them', () => {
    const body = buildSlackPayload({
      verdict: 'fail',
      stable: 'v0.62.1',
      runUrl: '',
      failures: ['src/thing.test.ts > a case'],
      refs,
    }).blocks[0].text.text;
    expect(body).toContain('src/thing.test.ts');
    expect(body).toContain('Also dropped from this batch');
    expect(body).toContain('PRD-7835');
    expect(body).toContain('conflicted in 1 file');
    expect(body).not.toContain('packages/app/package.json');
    expect(body).not.toContain('needs a human decision');
    expect(body).toContain('check it against the fixes');
  });

  test('a red tier with no dropped refs adds no drop section', () => {
    const body = buildSlackPayload({
      verdict: 'fail',
      stable: 'v0.62.1',
      runUrl: '',
      failures: ['src/thing.test.ts > a case'],
      refs: [],
    }).blocks[0].text.text;
    expect(body).not.toContain('Also dropped from this batch');
  });

  test('a red tier with no captured failures says so rather than rendering nothing', () => {
    const body = buildSlackPayload({
      verdict: 'fail',
      stable: 'v0.62.1',
      refs: [],
      runUrl: '',
      failures: [],
    }).blocks[0].text.text;
    expect(body).toContain('Both attempts went red');
    expect(body).not.toMatch(/\*Why it refused\*\n\n/);
    expect(body).toMatch(/if a failure is named above/i);
  });

  test('a red tier names only the first failure, with a count of the rest', () => {
    const failures = Array.from({ length: 11 }, (_, i) => `suite > case ${i}`);
    const body = buildSlackPayload({
      verdict: 'fail',
      stable: 'v0.62.1',
      refs: [],
      runUrl: '',
      failures,
    }).blocks[0].text.text;
    expect(body).toContain('case 0');
    expect(body).not.toContain('case 1');
    expect(body).toContain('and 10 more');
    expect(body).toContain('the stable is red on its own');
  });

  test('names the ticket, the reason and the stable, without the per-file breakdown', () => {
    const body = buildSlackPayload({
      verdict: 'conflict',
      stable: 'v0.48.9',
      refs,
      runUrl: 'https://example.test/run/1',
    }).blocks[0].text.text;
    expect(body).toContain('PRD-7835');
    expect(body).toContain('v0.48.9');
    expect(body).toContain('config drift');
    expect(body).toContain('conflicted in 1 file; 27 applied cleanly');
    expect(body).not.toContain('packages/app/package.json');
  });

  test('a pathless failure renders no empty conflict list and no phantom count', () => {
    const body = buildSlackPayload({
      verdict: 'conflict',
      stable: 'v0.50.2',
      refs: [
        {
          ref: '4cef9c5a587dc26ea4bcb5fe2ab134a1fa8ec00d',
          tickets: ['PRD-7310'],
          totalFiles: 37,
          inert: false,
          files: [],
        },
      ],
      runUrl: '',
    }).blocks[0].text.text;
    expect(body).not.toContain('conflicted in 0 files');
    expect(body).toContain('PRD-7310');
    expect(body).toContain('no conflicting file');
    expect(body).toContain('all 37 files applied cleanly');
  });

  test('keeps the silence-is-deliberate note', () => {
    const body = buildSlackPayload({ verdict: 'conflict', stable: 'v1', refs, runUrl: '' })
      .blocks[0].text.text;
    expect(body).toMatch(/Further identical refusals stay silent/);
  });

  test('has no emoji and no header block', () => {
    const payload = buildSlackPayload({ verdict: 'conflict', stable: 'v1', refs, runUrl: '' });
    expect(payload.blocks).toHaveLength(1);
    expect(payload.blocks[0].type).toBe('section');
    expect(JSON.stringify(payload)).not.toMatch(/[\u{1F000}-\u{1FFFF}☀-➿]/u);
    expect(payload.text).toBe(payload.blocks[0].text.text.split('\n')[0]);
  });

  test('a commit subject containing quotes cannot corrupt the payload', () => {
    const hostile = [
      { ...refs[0], tickets: ['"}, {"type":"section","text":"pwned'], files: refs[0].files },
    ];
    const payload = buildSlackPayload({
      verdict: 'conflict',
      stable: 'v1',
      refs: hostile,
      runUrl: '',
    });
    expect(JSON.parse(JSON.stringify(payload)).blocks).toHaveLength(1);
  });

  test('caps a large batch of refs instead of blowing Slack’s block limit', () => {
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
      .blocks[0].text.text;
    expect(body).toMatch(/and 7 more ref\(s\)/);
    expect(body).toContain('conflicted in 20 files');
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
  const step = (name) => {
    const start = bugLaneVerify.indexOf(`- name: ${name}`);
    if (start === -1) throw new Error(`bug-lane-verify.yml has no step named ${name}`);
    const rest = bugLaneVerify.slice(start);
    const end = rest.indexOf('\n      - name: ');
    return end === -1 ? rest : rest.slice(0, end);
  };

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
    expect(conflictCapture).toBeLessThan(abort);
  });

  test('the refusal page builds its body through this script', () => {
    expect(step('Page on a refusal')).toContain('bug-lane-refusal-payload.mjs');
  });

  test('the verify step separates an empty pick from a conflict', () => {
    const verify = shellOf('Verify the synthetic tree');
    const emptyGuard = verify.indexOf('git diff --quiet HEAD');
    const recordConflict = verify.indexOf('CONFLICT_JSON=$(jq');
    expect(emptyGuard).toBeGreaterThan(-1);
    expect(recordConflict).toBeGreaterThan(-1);
    expect(emptyGuard).toBeLessThan(recordConflict);
    expect(verify).toContain('already-in-stable');
  });

  test('only conflict, fail and could-not-verify can reach the pager', () => {
    const gate = step('Refusal signature');
    const verdicts = [...gate.matchAll(/verdict == '([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(verdicts)).toEqual(new Set(['conflict', 'fail', 'could-not-verify']));
    expect(verdicts).not.toContain('already-in-stable');
  });

  describe('a budget blow does not read as a red tier', () => {
    const payload = (verdict) =>
      buildSlackPayload({
        verdict,
        stable: 'v0.63.6',
        refs: [],
        runUrl: 'https://example.test/run',
        failures: ['the tiers did not finish within 1500s'],
      });
    const page = (verdict) => payload(verdict).blocks[0].text.text;

    test('says the batch retries itself, rather than naming a cause', () => {
      expect(JSON.stringify(payload('could-not-verify'))).toContain('verification timeout');
      const body = page('could-not-verify');

      expect(body).toContain('did not finish within 1500s');
      expect(body).toContain('nothing was verified about the queued fixes');
      expect(body).not.toMatch(/\*Why it refused\*\n\n/);
      expect(body).toContain('retries this batch automatically');
      expect(body).not.toContain('not flake-class');
      expect(body).not.toContain('red verification');
      expect(body).not.toContain('24h soak lane');
      expect(body).not.toContain("rides its cycle's stable");
    });

    test('a budget blow with no captured failures still says nothing was verified', () => {
      const body = buildSlackPayload({
        verdict: 'could-not-verify',
        stable: 'v1',
        refs: [],
        runUrl: '',
        failures: [],
      }).blocks[0].text.text;
      expect(body).toContain('ran out of their time budget');
      expect(body).toContain('nothing was verified about the queued fixes');
    });

    test('still accounts for refs dropped before the tiers ran', () => {
      const body = buildSlackPayload({
        verdict: 'could-not-verify',
        stable: 'v0.63.6',
        refs: [
          {
            ref: 'abc1234',
            inert: false,
            files: [
              { path: 'packages/core/src/index.ts', inert: false, detail: 'carries behavior' },
            ],
          },
        ],
        runUrl: 'https://example.test/run',
        failures: ['the tiers did not finish within 1500s (exit 124)'],
      }).blocks[0].text.text;
      expect(body).toContain('Also dropped from this batch');
      expect(body).toContain('abc1234');
      expect(body).toContain('conflicted in 1 file');
      expect(body).not.toContain('undefined');
    });

    test('still says all of that for a genuine red tier', () => {
      const body = page('fail');
      expect(body).toContain('not flake-class');
      expect(body).toContain('red verification');
      expect(body).not.toContain('ran out of');
      expect(body).toContain('The fix itself needs nothing');
      expect(body).not.toContain("No action needed — it rides its cycle's stable");
    });
  });

  test('the page does not default a JSON var with a brace expansion', () => {
    expect(shellOf('Page on a refusal')).not.toMatch(/\$\{[A-Za-z_]+:-\{/);
  });

  test('the plain-text fallback is emoji-free', () => {
    expect(shellOf('Page on a refusal')).not.toMatch(/[\u{1F000}-\u{1FFFF}☀-➿]/u);
  });

  test('the page restores the lane scripts the detached tree dropped', () => {
    const shell = shellOf('Page on a refusal');
    const restore = shell.indexOf('git checkout "$GITHUB_SHA"');
    const invoke = shell.indexOf('bug-lane-refusal-payload.mjs');
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(invoke);
  });

  test('the restore names one path at a time', () => {
    expect(shellOf('Page on a refusal')).toMatch(
      /for p in [^\n]*\n\s*git checkout "\$GITHUB_SHA" -- "\$p"/,
    );
  });

  test('the lane still never authorizes conflict resolution when dispatching', () => {
    expect(bugLane).not.toContain('resolve_paths');
    expect(bugLaneVerify).not.toContain('resolve_paths');
  });

  test('step() throws on a missing name instead of returning a degenerate slice', () => {
    expect(() => step('This step does not exist')).toThrow(/has no step named/);
  });

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

  test('dispatch inputs reach the shell only through env, never `${{ }}` splicing', () => {
    const dir = join(REPO_ROOT, '.github', 'workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length, 'no workflows found to scan').toBeGreaterThan(0);

    for (const file of files) {
      const yaml = readFileSync(join(dir, file), 'utf8');
      const bodies = runBodies(yaml);
      const declared = yaml.split('\n').filter((l) => /^\s*run: /.test(l)).length;
      expect(bodies.length, `${file}: walker missed a run: block`).toBe(declared);
      const spliced = bodies.filter((b) => /\$\{\{\s*(github\.event\.)?inputs\./.test(b));
      expect(spliced, `${file}: inputs spliced into a run: body`).toEqual([]);
    }
  });

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
    expect(bodies[0]).toContain('third');
    expect(bodies[0]).not.toContain('- name: two');
    expect(bodies[1]).toBe('echo inline');
  });
});
