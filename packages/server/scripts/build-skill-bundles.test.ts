/**
 * Unit tests for the shared-content composer + CI byte-equality guard.
 *
 * `composeSkill` is covered as a pure function with synthetic placeholders.
 * `buildSkillBundles` + `checkSharedContentByteEquality` are exercised against
 * tmpdir fixtures, then the guard is run once against the REAL repo assets so
 * `bun run check` fails on any production drift.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUNDLE_IDS,
  buildPackSkills,
  buildSkillBundles,
  checkSharedContentByteEquality,
  composeSkill,
  defaultPaths,
  type SkillBundlePaths,
} from './build-skill-bundles.ts';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const p = cleanup.pop();
    if (p) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
});

/**
 * Build a tmpdir fixture with the given per-bundle bodies + _shared files.
 * `references` seeds arbitrary skillsDir-relative files (e.g.
 * `project/references/setup.md`) to exercise the full-dir copy.
 */
function fixture(opts: {
  discovery: string;
  project: string;
  shared?: Record<string, string>;
  references?: Record<string, string>;
}): SkillBundlePaths {
  const root = mkdtempSync(join(tmpdir(), 'ok-skill-compose-'));
  cleanup.push(root);
  const skillsDir = join(root, 'skills');
  for (const bundle of BUNDLE_IDS) mkdirSync(join(skillsDir, bundle), { recursive: true });
  mkdirSync(join(skillsDir, '_shared'), { recursive: true });
  // Every bundle needs a SKILL.md to compose; the tests drive discovery/project,
  // so any other id in BUNDLE_IDS (e.g. write-skill) gets a trivial
  // placeholder-free default — adding a bundle id never breaks the fixture.
  for (const bundle of BUNDLE_IDS) {
    writeFileSync(join(skillsDir, bundle, 'SKILL.md'), `# ${bundle}\n`);
  }
  writeFileSync(join(skillsDir, 'discovery', 'SKILL.md'), opts.discovery);
  writeFileSync(join(skillsDir, 'project', 'SKILL.md'), opts.project);
  for (const [name, body] of Object.entries(opts.shared ?? {})) {
    writeFileSync(join(skillsDir, '_shared', name), body);
  }
  for (const [rel, body] of Object.entries(opts.references ?? {})) {
    const dest = join(skillsDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  return { skillsDir, distDir: join(root, 'dist', 'assets', 'skills') };
}

describe('composeSkill', () => {
  test('text with no placeholders passes through unchanged', () => {
    const { composed, placeholders } = composeSkill('# Title\n\nbody.\n', () => 'X');
    expect(composed).toBe('# Title\n\nbody.\n');
    expect(placeholders).toEqual([]);
  });

  test('resolves a single placeholder', () => {
    const { composed, placeholders } = composeSkill(
      'before {{> _shared/snip.md }} after',
      (name) => (name === 'snip.md' ? 'SNIPPET' : '??'),
    );
    expect(composed).toBe('before SNIPPET after');
    expect(placeholders).toEqual(['snip.md']);
  });

  test('resolves multiple distinct placeholders and dedupes the name list', () => {
    const { composed, placeholders } = composeSkill(
      '{{> _shared/a.md }} / {{> _shared/b.md }} / {{> _shared/a.md }}',
      (name) => name.toUpperCase(),
    );
    expect(composed).toBe('A.MD / B.MD / A.MD');
    expect(placeholders).toEqual(['a.md', 'b.md']);
  });

  test('tolerates extra whitespace inside the placeholder', () => {
    const { composed } = composeSkill('{{>_shared/x.md}}|{{>   _shared/x.md   }}', () => 'Y');
    expect(composed).toBe('Y|Y');
  });
});

describe('buildSkillBundles', () => {
  test('composes EVERY canonical bundle into dist/<bundle>/SKILL.md and resolves placeholders', () => {
    const paths = fixture({
      discovery: 'discovery: {{> _shared/intro.md }}\n',
      project: 'project: {{> _shared/intro.md }}\n',
      shared: { 'intro.md': 'SHARED-INTRO' },
    });
    const built = buildSkillBundles(paths);
    // Every id in the single-sourced BUNDLE_IDS is composed — this is the guard
    // that caught write-skill being silently omitted from the dist build.
    expect(built.map((b) => b.bundle).sort()).toEqual([...BUNDLE_IDS].sort());
    for (const id of ['discovery', 'project'] as const) {
      const b = built.find((x) => x.bundle === id);
      expect(b && existsSync(b.outputPath)).toBe(true);
      const text = readFileSync(b?.outputPath ?? '', 'utf-8');
      expect(text).toContain('SHARED-INTRO');
      expect(text).not.toContain('{{>');
      expect(b?.placeholders).toEqual(['intro.md']);
    }
  });

  test('copies a bundle’s references/ into dist so the complete bundle ships (H1)', () => {
    // Regression guard: the composer used to write only SKILL.md, so a bundle's
    // references/ never reached published / desktop builds (resolveBundledSkillDir
    // prefers dist). The full-dir copy must carry them.
    const paths = fixture({
      discovery: '# d\n',
      project: '# p\n',
      references: { 'project/references/setup.md': 'SETUP-DOC' },
    });
    buildSkillBundles(paths);
    const ref = join(paths.distDir, 'project', 'references', 'setup.md');
    expect(existsSync(ref)).toBe(true);
    expect(readFileSync(ref, 'utf-8')).toBe('SETUP-DOC');
  });

  test('identity transform when no placeholders are used (v1 case)', () => {
    const paths = fixture({ discovery: '# d\n', project: '# p\n' });
    const built = buildSkillBundles(paths);
    const discovery = built.find((b) => b.bundle === 'discovery');
    expect(discovery?.placeholders).toEqual([]);
    expect(readFileSync(discovery?.outputPath ?? '', 'utf-8')).toBe('# d\n');
  });

  test('throws when a referenced _shared file is absent', () => {
    const paths = fixture({
      discovery: '{{> _shared/missing.md }}',
      project: '# p\n',
    });
    expect(() => buildSkillBundles(paths)).toThrow(/missing\.md/);
  });
});

describe('repo assets — progressive-disclosure references', () => {
  // Production guard: the real project skill ships its references/ tree (the
  // core/reference split). Main's test proves the build copies a bundle's
  // references/ into dist; this asserts the actual shipped project bundle HAS
  // them, catching a future change that drops the split.
  test('the project bundle ships a non-empty references/ dir', () => {
    const refsDir = join(defaultPaths().skillsDir, 'project', 'references');
    expect(existsSync(refsDir)).toBe(true);
    const refs = readdirSync(refsDir).filter((f) => f.endsWith('.md'));
    expect(refs.length).toBeGreaterThan(0);
  });

  // Pointer-completeness: progressive disclosure only works if every reference
  // is reachable from the core by exactly the path the agent will load, and the
  // core never points at a reference that isn't there. Bidirectional guard:
  // no dead pointer (core → missing file) and no orphan (file → never pointed at).
  test('every reference is pointed to from the core and every pointer resolves', () => {
    const projectDir = join(defaultPaths().skillsDir, 'project');
    const core = readFileSync(join(projectDir, 'SKILL.md'), 'utf-8');
    const refsDir = join(projectDir, 'references');
    const onDisk = new Set(readdirSync(refsDir).filter((f) => f.endsWith('.md')));
    // `references/<name>.md` pointers in the core (backtick paths or md links).
    // The `*`/`<` in prose like `references/*.md` or `references/<topic>.md` is
    // excluded by the character class, so only real pointers match.
    const pointed = new Set(
      [...core.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]),
    );
    // No dead pointer: every pointer resolves to a file on disk.
    for (const name of pointed) {
      expect({ pointer: name, exists: existsSync(join(refsDir, name)) }).toEqual({
        pointer: name,
        exists: true,
      });
    }
    // No orphan: every reference file is pointed to from the core.
    for (const name of onDisk) {
      expect({ reference: name, pointed: pointed.has(name) }).toEqual({
        reference: name,
        pointed: true,
      });
    }
  });

  // Enforce the spec's core-body byte gate (<= 20,000 bytes, ~5k
  // tokens) in CI — it was documented but unenforced. Strip the YAML frontmatter
  // and measure the body the agent actually loads on every activation.
  test('project core body is within the 20,000-byte gate (spec V4/R-IS1)', () => {
    const raw = readFileSync(join(defaultPaths().skillsDir, 'project', 'SKILL.md'), 'utf-8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(20_000);
  });
});

describe('buildPackSkills', () => {
  test('composes each packs/<id>/SKILL.md into dist/packs/<id>/', () => {
    const paths = fixture({ discovery: '# d\n', project: '# p\n' });
    const packDir = join(paths.skillsDir, 'packs', 'demo-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'SKILL.md'), '# demo pack\n');
    expect(buildPackSkills(paths)).toEqual(['demo-pack']);
    const out = join(paths.distDir, 'packs', 'demo-pack', 'SKILL.md');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toBe('# demo pack\n');
  });

  test('returns [] when there is no packs/ directory', () => {
    expect(buildPackSkills(fixture({ discovery: '# d\n', project: '# p\n' }))).toEqual([]);
  });

  // Production guard (read-only): every shipped pack must have a source SKILL.md,
  // so the build copies it into dist. Without it, `ok seed`'s pack-skill install
  // resolves only against the source tree (dev) and silently no-ops in built
  // CLI / desktop artifacts.
  test('repo assets — all eight starter packs are present to build', () => {
    const packsDir = join(defaultPaths().skillsDir, 'packs');
    const expected = [
      'codebase-wiki',
      'entity-vault',
      'knowledge-base',
      'okf',
      'plain-notes',
      'software-lifecycle',
      'worldbuilding',
      'writing-pipeline',
    ];
    for (const id of expected) {
      expect(existsSync(join(packsDir, id, 'SKILL.md'))).toBe(true);
    }
  });
});

describe('checkSharedContentByteEquality', () => {
  test('passes when placeholders resolve to byte-identical shared content', () => {
    const paths = fixture({
      discovery: 'd {{> _shared/s.md }}',
      project: 'p {{> _shared/s.md }}',
      shared: { 's.md': 'EXACT-BYTES' },
    });
    const result = checkSharedContentByteEquality(paths);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('passes trivially when no bundle references a placeholder', () => {
    const paths = fixture({ discovery: '# d\n', project: '# p\n' });
    expect(checkSharedContentByteEquality(paths).ok).toBe(true);
  });

  test('flags a missing _shared file as a violation', () => {
    const paths = fixture({
      discovery: '{{> _shared/gone.md }}',
      project: '# p\n',
    });
    const result = checkSharedContentByteEquality(paths);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('gone.md');
  });
});

describe('repo assets — production guard', () => {
  test('checkSharedContentByteEquality passes against the real skill bundles', () => {
    const result = checkSharedContentByteEquality(defaultPaths());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('every real source bundle exists and shared placeholders are resolvable', () => {
    const { skillsDir } = defaultPaths();
    for (const bundle of BUNDLE_IDS) {
      expect(existsSync(join(skillsDir, bundle, 'SKILL.md'))).toBe(true);
    }
    const hasSharedSources = existsSync(join(skillsDir, '_shared'));
    const bundlesReferenceShared = BUNDLE_IDS.some((bundle) =>
      readFileSync(join(skillsDir, bundle, 'SKILL.md'), 'utf-8').includes('{{> _shared/'),
    );
    expect(hasSharedSources || !bundlesReferenceShared).toBe(true);
  });

  test('every bundle carries a distinct frontmatter name: value (shadow prevention)', () => {
    // Distinct `name:` values are load-bearing — a same-name global-scope
    // skill would shadow the project-scope one in the host hierarchy.
    const { skillsDir } = defaultPaths();
    const expected: Record<(typeof BUNDLE_IDS)[number], string> = {
      discovery: 'open-knowledge-discovery',
      project: 'open-knowledge',
      'write-skill': 'open-knowledge-write-skill',
    };
    const names = new Set<string>();
    for (const bundle of BUNDLE_IDS) {
      const md = readFileSync(join(skillsDir, bundle, 'SKILL.md'), 'utf-8');
      const want = expected[bundle];
      expect(new RegExp(`^name:\\s*${want}\\s*$`, 'm').test(md)).toBe(true);
      names.add(want);
    }
    expect(names.size).toBe(BUNDLE_IDS.length);
  });
});
