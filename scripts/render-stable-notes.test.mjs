import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../test-support/configure-git-fixture.test-helper.ts';
import {
  NOTES_SOURCE_MARKER as DOCS_NOTES_SOURCE_MARKER,
  markedNotes,
} from '../docs/src/lib/releases.ts';
import { fixedGroupOf } from './changeset-versions.mjs';
import { gitCleanEnv } from './git-clean-env.mjs';
import {
  changesetSummary,
  collectStableNotes,
  EMPTY_NOTES,
  NOTES_SOURCE_MARKER,
  noteLevel,
  noteReaderAt,
  parseArgs,
  parseNoteLevels,
  recordNoteLevels,
  renderStableNotes,
  stableNotes,
  withNoteLevels,
} from './render-stable-notes.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const OK_ROOT = dirname(SCRIPTS);
const OK = '@inkeep/open-knowledge';
const CORE = '@inkeep/open-knowledge-core';
const FIXED = [
  OK,
  CORE,
  '@inkeep/open-knowledge-server',
  '@inkeep/open-knowledge-app',
  '@inkeep/open-knowledge-desktop',
];
const CONFIG = JSON.stringify({ changelog: '@changesets/cli/changelog', fixed: [FIXED] });

const changeset = (frontmatter, summary) => `---\n${frontmatter}\n---\n\n${summary}\n`;

const repos = [];

afterEach(() => {
  while (repos.length) rmSync(repos.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, env: gitCleanEnv(), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  repos.push(dir);
  return dir;
}

function releaseHistory({ subtree = '' } = {}) {
  const root = tempDir('stable-notes-history-');
  const base = join(root, subtree);
  const changesetDir = join(base, '.changeset');
  git(root, ['init', '-q', '-b', 'main']);
  configureTestGitRepository(root);
  mkdirSync(changesetDir, { recursive: true });
  writeFileSync(join(changesetDir, 'config.json'), CONFIG);
  writeFileSync(join(changesetDir, 'README.md'), '# Changesets\n');
  const commit = (message, files = {}, removed = []) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(changesetDir, name), body);
    for (const name of removed) git(root, ['rm', '-q', join(changesetDir, name)]);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    ]);
    return git(root, ['rev-parse', 'HEAD']).trim();
  };
  return { root, base, commit, tag: (name, sha) => git(root, ['tag', name, sha]) };
}

describe('renderStableNotes', () => {
  test('groups entries by level, omits empty levels and ends with the source marker', () => {
    const out = renderStableNotes(
      [
        { id: 'b-fix', level: 'patch', summary: 'Fix b.' },
        { id: 'a-feature', level: 'minor', summary: 'Add a.' },
        { id: 'a-fix', level: 'patch', summary: 'Fix a.' },
      ],
      { marked: true },
    );
    expect(out).toBe(
      `### Minor Changes\n\n- Add a.\n\n### Patch Changes\n\n- Fix a.\n- Fix b.\n\n${NOTES_SOURCE_MARKER}\n`,
    );
  });

  test('orders entries by changeset file name, the order Changesets reads them in', () => {
    const out = renderStableNotes([
      { id: 'foo', level: 'patch', summary: 'Second, because foo.md sorts after foo-bar.md.' },
      { id: 'foo-bar', level: 'patch', summary: 'First.' },
      { id: 'Zed', level: 'patch', summary: 'Upper case sorts before lower case.' },
    ]);
    expect(out.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      '- Upper case sorts before lower case.',
      '- First.',
      '- Second, because foo.md sorts after foo-bar.md.',
    ]);
  });

  test('indents continuation lines and separates a multi-paragraph entry from the next one', () => {
    const out = renderStableNotes(
      [
        { id: 'a', level: 'patch', summary: 'Lead.\n\nSecond paragraph.\n- nested item' },
        { id: 'b', level: 'patch', summary: 'Single line.' },
        { id: 'c', level: 'patch', summary: 'Last.' },
      ],
      { marked: true },
    );
    expect(out).toBe(
      '### Patch Changes\n\n- Lead.\n\n  Second paragraph.\n  - nested item\n\n- Single line.\n- Last.\n\n' +
        `${NOTES_SOURCE_MARKER}\n`,
    );
  });

  test('the docs changelog reads the marker this renderer writes', () => {
    expect(DOCS_NOTES_SOURCE_MARKER).toBe(NOTES_SOURCE_MARKER);
    const rendered = renderStableNotes([{ id: 'a-fix', level: 'patch', summary: 'A fix.' }], {
      marked: true,
    });
    const body = `${rendered}\n<!-- ok-downloads:start -->\n| a |\n<!-- ok-downloads:end -->\n`;
    expect(markedNotes(body)).toBe('### Patch Changes\n\n- A fix.');
    expect(markedNotes(renderStableNotes([], { marked: true }))).toBeNull();
  });

  test('a release with no entries says so and carries no marker', () => {
    expect(renderStableNotes([], { marked: true })).toBe(`${EMPTY_NOTES}\n`);
  });
});

describe('renderStableNotes matches what `changeset version` writes to the CLI changelog', () => {
  const entries = {
    'b-multi': {
      level: 'patch',
      summary:
        'A fix with detail.\n\nThe second paragraph explains it.\n\n- a nested point\n- another point\n\nA closing paragraph.',
    },
    'a-feature': { level: 'minor', summary: 'Add a feature.' },
    'c-plain': {
      level: 'patch',
      summary: 'A plain one-line fix with `code` and a [link](https://example.com).',
    },
    'c-plain-tail': { level: 'patch', summary: 'Sorted before c-plain.md by file name.' },
    'd-fence': {
      level: 'patch',
      summary: 'A fix with a fence.\n\n```sh\nok start\n\nok stop\n```',
    },
  };

  test('byte for byte, once the commit hash is stripped', () => {
    const root = tempDir('stable-notes-changesets-oracle-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: OK, version: '0.1.0' }, null, 2),
    );
    mkdirSync(join(root, '.changeset'));
    writeFileSync(
      join(root, '.changeset', 'config.json'),
      JSON.stringify({ changelog: '@changesets/cli/changelog', commit: false, fixed: [[OK]] }),
    );
    for (const [id, { level, summary }] of Object.entries(entries)) {
      writeFileSync(join(root, '.changeset', `${id}.md`), changeset(`"${OK}": ${level}`, summary));
    }
    git(root, ['init', '-q', '-b', 'main']);
    configureTestGitRepository(root);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'changesets',
    ]);

    const bin = createRequire(join(OK_ROOT, 'package.json')).resolve('@changesets/cli/bin.js');
    const res = spawnSync(process.execPath, [bin, 'version'], {
      cwd: root,
      env: gitCleanEnv(),
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);

    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const heading = changelog.indexOf('## 0.2.0');
    expect(heading).toBeGreaterThan(-1);
    const section = changelog
      .slice(heading + '## 0.2.0'.length)
      .replace(/^(\s*[-*] )[0-9a-f]{6,40}: /gm, '$1')
      .trim();
    const rendered = renderStableNotes(
      Object.entries(entries).map(([id, entry]) => ({ id, ...entry })),
      { marked: true },
    );
    expect(rendered).toBe(`${section}\n\n${NOTES_SOURCE_MARKER}\n`);
  });
});

describe('section levels match the CLI changelog `changeset version` writes for a fixed group', () => {
  test('a changeset naming the CLI is filed under its CLI bump, not the group maximum', () => {
    const root = tempDir('stable-notes-changesets-levels-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2),
    );
    for (const [dir, name] of [
      ['cli', OK],
      ['core', CORE],
    ]) {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      writeFileSync(
        join(root, 'packages', dir, 'package.json'),
        JSON.stringify({ name, version: '0.1.0' }, null, 2),
      );
    }
    mkdirSync(join(root, '.changeset'));
    const config = { changelog: '@changesets/cli/changelog', commit: false, fixed: [[OK, CORE]] };
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify(config));
    const files = {
      'a-mixed': changeset(`"${CORE}": minor\n"${OK}": patch`, 'Core minor, CLI patch.'),
      'b-cli-minor': changeset(`"${OK}": minor`, 'A CLI feature.'),
    };
    for (const [id, text] of Object.entries(files)) {
      writeFileSync(join(root, '.changeset', `${id}.md`), text);
    }
    git(root, ['init', '-q', '-b', 'main']);
    configureTestGitRepository(root);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'changesets',
    ]);

    const bin = createRequire(join(OK_ROOT, 'package.json')).resolve('@changesets/cli/bin.js');
    const res = spawnSync(process.execPath, [bin, 'version'], {
      cwd: root,
      env: gitCleanEnv(),
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);

    const changelog = readFileSync(join(root, 'packages', 'cli', 'CHANGELOG.md'), 'utf8');
    const heading = changelog.indexOf('## 0.2.0');
    expect(heading).toBeGreaterThan(-1);
    const section = changelog
      .slice(heading + '## 0.2.0'.length)
      .replace(/^(\s*[-*] )[0-9a-f]{6,40}: /gm, '$1')
      .trim();
    const reader = noteReaderAt(root);
    const head = reader.revParse('HEAD');
    const rendered = renderStableNotes(
      Object.keys(files).map((id) => ({
        id,
        level: reader.noteLevelOf(head, id),
        summary: changesetSummary(reader.changesetText(head, id)),
      })),
      { marked: true },
    );
    expect(rendered).toBe(`${section}\n\n${NOTES_SOURCE_MARKER}\n`);
    expect(section).toMatch(/### Patch Changes\n\n- Core minor, CLI patch\./);
  });
});

describe('changesetSummary', () => {
  test('reads the text after the frontmatter, trimmed, as @changesets/parse does', () => {
    expect(changesetSummary(`---\n"${OK}": patch\n---\n\n  A fix.\n\nMore.\n\n`)).toBe(
      'A fix.\n\nMore.',
    );
  });

  test('refuses a file with no frontmatter', () => {
    expect(() => changesetSummary('Just text.\n')).toThrow(/no frontmatter/);
  });
});

describe('noteLevel', () => {
  test('is the bump a changeset declares for the CLI package when it names the CLI', () => {
    const releases = [
      { name: OK, type: 'patch' },
      { name: CORE, type: 'minor' },
      { name: '@inkeep/open-knowledge-docs', type: 'major' },
    ];
    expect(noteLevel(releases, FIXED)).toBe('patch');
  });

  test('is the highest fixed-group bump when the changeset does not name the CLI', () => {
    const releases = [
      { name: '@inkeep/open-knowledge-desktop', type: 'patch' },
      { name: CORE, type: 'minor' },
      { name: '@inkeep/open-knowledge-docs', type: 'major' },
    ];
    expect(noteLevel(releases, FIXED)).toBe('minor');
  });

  test('falls back to the fixed group when the changeset declares `none` for the CLI', () => {
    const releases = [
      { name: OK, type: 'none' },
      { name: '@inkeep/open-knowledge-desktop', type: 'patch' },
    ];
    expect(noteLevel(releases, FIXED)).toBe('patch');
  });

  test('is null for a changeset that names no fixed-group package or only `none`', () => {
    expect(noteLevel([{ name: '@inkeep/open-knowledge-docs', type: 'patch' }], FIXED)).toBeNull();
    expect(noteLevel([{ name: OK, type: 'none' }], FIXED)).toBeNull();
  });

  test('reads the fixed group that contains the CLI package from the Changesets config', () => {
    expect(fixedGroupOf(JSON.parse(CONFIG))).toEqual(FIXED);
    expect(fixedGroupOf({ fixed: [['other-a', 'other-b']] })).toEqual([OK]);
    expect(fixedGroupOf({})).toEqual([OK]);
  });
});

describe('collectStableNotes over a release history', () => {
  test('lists only changesets no other stable tag carries, with their text at the commit', () => {
    const h = releaseHistory();
    const a = h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X shipped in A.') });
    h.tag('v1.0.0', a);
    h.commit('B', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y as first written.') });
    const c = h.commit('C', {
      'y-fix.md': changeset(`"${OK}": patch`, 'Y as it ships.'),
      'z-feature.md': changeset(`"${CORE}": minor`, 'Z.'),
      'docs-only.md': changeset('"@inkeep/open-knowledge-docs": patch', 'Docs only.'),
    });

    const notes = collectStableNotes({ commit: c, excludeTags: ['v1.1.0'] }, noteReaderAt(h.base));
    expect(notes).toEqual([
      { id: 'y-fix', level: 'patch', summary: 'Y as it ships.' },
      { id: 'z-feature', level: 'minor', summary: 'Z.' },
    ]);
  });

  test('a changeset a revert point release removed stays released for every later stable', () => {
    const h = releaseHistory();
    const a = h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') });
    h.tag('v1.0.0', a);
    const main = h.commit('main after A', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    git(h.root, ['checkout', '-q', '--detach', a]);
    const revert = h.commit('revert X', {}, ['x-fix.md']);
    h.tag('v1.0.1', revert);
    git(h.root, ['checkout', '-q', 'main']);
    expect(git(h.root, ['ls-tree', '--name-only', main, '--', '.changeset/'])).toContain(
      'x-fix.md',
    );

    const reader = noteReaderAt(h.base);
    const notes = collectStableNotes({ commit: main, excludeTags: ['v1.1.0'] }, reader);
    expect(notes.map((entry) => entry.id)).toEqual(['y-fix']);
  });

  test('the tag being rendered is excluded, so a re-run renders the same notes', () => {
    const h = releaseHistory();
    h.tag('v1.0.0', h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const b = h.commit('B', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    h.tag('v1.0.1', b);
    const reader = noteReaderAt(h.base);
    expect(
      collectStableNotes({ commit: b, excludeTags: ['v1.0.1'] }, reader).map((e) => e.id),
    ).toEqual(['y-fix']);
    expect(collectStableNotes({ commit: b }, reader)).toEqual([]);
  });

  test('with no stable tag at all every changeset in the tree is rendered', () => {
    const h = releaseHistory();
    const a = h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') });
    expect(collectStableNotes({ commit: a }, noteReaderAt(h.base)).map((e) => e.id)).toEqual([
      'x-fix',
    ]);
  });

  test('from a monorepo subtree it reads the subtree .changeset', () => {
    const h = releaseHistory({ subtree: 'public/open-knowledge' });
    const a = h.commit('A', { 'x-fix.md': changeset(`"${OK}": minor`, 'X.') });
    expect(collectStableNotes({ commit: a }, noteReaderAt(h.base))).toEqual([
      { id: 'x-fix', level: 'minor', summary: 'X.' },
    ]);
  });
});

describe('only stable tags whose Release published count as released', () => {
  test('a stable whose Release never published releases nothing, so the next one lists its changesets', () => {
    const h = releaseHistory();
    h.tag('v0.9.0', h.commit('A', { 'w-fix.md': changeset(`"${OK}": patch`, 'W.') }));
    h.tag('v1.0.0', h.commit('B', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const c = h.commit('C', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    const reader = noteReaderAt(h.base);

    const published = collectStableNotes(
      { commit: c, excludeTags: ['v1.0.1'], releasedTags: ['v0.9.0'] },
      reader,
    );
    expect(published.map((entry) => entry.id)).toEqual(['x-fix', 'y-fix']);
    expect(
      collectStableNotes({ commit: c, excludeTags: ['v1.0.1'] }, reader).map((entry) => entry.id),
    ).toEqual(['y-fix']);
  });

  test('the marker follows the released set: only a published list marks the body', () => {
    const h = releaseHistory();
    h.tag('v0.9.0', h.commit('A', { 'w-fix.md': changeset(`"${OK}": patch`, 'W.') }));
    h.tag('v1.0.0', h.commit('B', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const c = h.commit('C', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    const reader = noteReaderAt(h.base);

    expect(
      stableNotes({ commit: c, excludeTags: ['v1.0.1'], publishedTags: ['v0.9.0'] }, reader),
    ).toBe(`### Patch Changes\n\n- X.\n- Y.\n\n${NOTES_SOURCE_MARKER}\n`);
    expect(stableNotes({ commit: c, excludeTags: ['v1.0.1'] }, reader)).toBe(
      '### Patch Changes\n\n- Y.\n',
    );
  });

  test('a render that is not asked to mark keeps the notes and drops only the marker', () => {
    const entries = [{ id: 'a-fix', level: 'patch', summary: 'A fix.' }];
    expect(renderStableNotes(entries)).toBe('### Patch Changes\n\n- A fix.\n');
  });
});

describe('note levels carry the Changesets read from the reader job to the release job', () => {
  test('levels recorded where the reader ran answer the same blobs where it cannot run', () => {
    const h = releaseHistory();
    const a = h.commit('A', {
      'x-fix.md': changeset(`"${OK}": patch`, 'X.'),
      'y-feature.md': changeset(`"${CORE}": minor`, 'Y.'),
    });
    const levels = new Map();
    const read = collectStableNotes({ commit: a }, recordNoteLevels(noteReaderAt(h.base), levels));
    expect([...levels.values()].sort()).toEqual(['minor', 'patch']);

    const noReader = withNoteLevels(
      {
        ...noteReaderAt(h.base),
        noteLevelOf: () => {
          throw new Error('the Changesets reader is not installed in this job');
        },
      },
      levels,
    );
    expect(collectStableNotes({ commit: a }, noReader)).toEqual(read);

    const later = h.commit('B', { 'z-fix.md': changeset(`"${OK}": patch`, 'Z.') });
    expect(() => collectStableNotes({ commit: later }, noReader)).toThrow(
      /no note level for \.changeset\/z-fix\.md/,
    );
  });

  test('parseNoteLevels names the note_levels output when it is missing', () => {
    expect(() => parseNoteLevels('')).toThrow(
      /^NOTE_LEVELS is empty: the read-bumps job wrote no note_levels output/,
    );
    expect(parseNoteLevels('{"abc":null}')).toEqual(new Map([['abc', null]]));
    expect(() => parseNoteLevels('[]')).toThrow(
      'note levels must be a JSON object mapping changeset blob ids to release-note levels.',
    );
  });
});

describe('parseArgs', () => {
  test('reads the commit, repeated exclusions and the read-levels mode, ignoring an empty exclusion', () => {
    expect(
      parseArgs([
        '--commit',
        'abc',
        '--exclude-tag',
        'v1.0.0',
        '--exclude-tag',
        '',
        '--read-levels',
      ]),
    ).toEqual({
      readLevels: true,
      commit: 'abc',
      excludeTags: ['v1.0.0'],
      releasesFile: '',
    });
    expect(parseArgs(['--commit', 'abc', '--releases', '/tmp/r']).releasesFile).toBe('/tmp/r');
  });

  test('refuses a missing commit and unknown arguments', () => {
    expect(() => parseArgs([])).toThrow(/--commit <sha> is required/);
    expect(() => parseArgs(['--commit', 'abc', '--bogus'])).toThrow(/unknown argument '--bogus'/);
  });
});

describe('the release job renders the notes with no node_modules at all', () => {
  const SCRIPT_FILES = [
    'render-stable-notes.mjs',
    'compute-stable-version.mjs',
    'changeset-versions.mjs',
    'git-clean-env.mjs',
  ];

  function isolatedScript() {
    const dir = tempDir('stable-notes-no-node-modules-');
    mkdirSync(join(dir, 'scripts'));
    for (const file of SCRIPT_FILES) copyFileSync(join(SCRIPTS, file), join(dir, 'scripts', file));
    mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
    copyFileSync(
      join(OK_ROOT, '.github', 'scripts', 'shipped-fix-containment.mjs'),
      join(dir, '.github', 'scripts', 'shipped-fix-containment.mjs'),
    );
    return join(dir, 'scripts', 'render-stable-notes.mjs');
  }

  function releaseListing(releases) {
    const file = join(tempDir('stable-notes-releases-'), 'releases.jsonl');
    const lines = releases.map(([tag, draft]) =>
      JSON.stringify({ tag_name: tag, draft, body: '' }),
    );
    writeFileSync(file, lines.join('\n'));
    return file;
  }

  function run(script, cwd, args, env = {}) {
    const outDir = tempDir('stable-notes-output-');
    const output = join(outDir, 'github-output');
    writeFileSync(output, '');
    const { NOTE_LEVELS: _inherited, ...base } = gitCleanEnv();
    const res = spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...base, GITHUB_OUTPUT: output, ...env },
    });
    return { ...res, output: readFileSync(output, 'utf8') };
  }

  test('the reader job records note_levels and the release job renders byte-identical notes from them', () => {
    const h = releaseHistory();
    h.tag('v1.0.0', h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const b = h.commit('B', {
      'y-fix.md': changeset(`"${OK}": patch`, 'Y.'),
      'z-feature.md': changeset(`"${CORE}": minor`, 'Z.'),
    });
    const releases = releaseListing([
      ['v1.0.0', false],
      ['v1.1.0-beta.1', false],
    ]);
    const args = ['--commit', b, '--exclude-tag', 'v1.1.0', '--releases', releases];

    const withReader = run(join(SCRIPTS, 'render-stable-notes.mjs'), h.root, args);
    expect(withReader.status, withReader.stderr).toBe(0);
    expect(withReader.stdout).toBe(
      `### Minor Changes\n\n- Z.\n\n### Patch Changes\n\n- Y.\n\n${NOTES_SOURCE_MARKER}\n`,
    );

    const reading = run(join(SCRIPTS, 'render-stable-notes.mjs'), h.root, [
      '--commit',
      b,
      '--read-levels',
    ]);
    expect(reading.status, reading.stderr).toBe(0);
    const levels = /^note_levels=(.*)$/m.exec(reading.output)?.[1];
    expect(Object.values(JSON.parse(levels ?? '{}')).sort()).toEqual(['minor', 'patch', 'patch']);

    const isolated = run(isolatedScript(), h.root, args, { NOTE_LEVELS: levels });
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(isolated.stdout).toBe(withReader.stdout);
  });

  test('a stable tag whose Release is still a draft releases nothing, so its changesets are listed again', () => {
    const h = releaseHistory();
    h.tag('v0.9.0', h.commit('A', { 'w-fix.md': changeset(`"${OK}": patch`, 'W.') }));
    h.tag('v1.0.0', h.commit('B', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const c = h.commit('C', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    const releases = releaseListing([
      ['v0.9.0', false],
      ['v1.0.0', true],
    ]);
    const res = run(join(SCRIPTS, 'render-stable-notes.mjs'), h.root, [
      '--commit',
      c,
      '--releases',
      releases,
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(`### Patch Changes\n\n- X.\n- Y.\n\n${NOTES_SOURCE_MARKER}\n`);
  });

  test('when the published Releases cannot be read the notes carry no marker and warn they may omit changesets', () => {
    const h = releaseHistory();
    h.tag('v1.0.0', h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') }));
    const b = h.commit('B', { 'y-fix.md': changeset(`"${OK}": patch`, 'Y.') });
    const res = run(join(SCRIPTS, 'render-stable-notes.mjs'), h.root, [
      '--commit',
      b,
      '--releases',
      releaseListing([]),
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe('### Patch Changes\n\n- Y.\n');
    expect(res.stderr).toMatch(
      /::warning::render-stable-notes: could not read the published stable Releases \(.*holds no stable Release/,
    );
    expect(res.stderr).toMatch(
      /may leave out changesets first tagged in a stable whose Release never published/,
    );
  });

  test('without note levels the isolated copy cannot load the reader, so the run above never tried', () => {
    const h = releaseHistory();
    const a = h.commit('A', { 'x-fix.md': changeset(`"${OK}": patch`, 'X.') });
    const res = run(isolatedScript(), h.root, ['--commit', a, '--releases', releaseListing([])]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/@changesets\/cli/);
    expect(res.stdout).toBe('');
  });
});
