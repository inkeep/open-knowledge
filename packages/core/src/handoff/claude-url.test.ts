import { expect, test } from 'bun:test';
import { buildClaudeUrl } from './claude-url.ts';
import { composeEmptySpacePrompt } from './prompt-composer.ts';
import type { HandoffPayload } from './types.ts';

function payload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  return {
    target: 'claude-cowork',
    projectDir: '/Users/who/proj',
    docPath: '/Users/who/proj/docs/note.md',
    prompt: 'open this',
    ...overrides,
  };
}

test('buildClaudeUrl threads prompt for doc-scoped cowork as q=<prompt>&folder=<projectDir>', () => {
  // Prompt threaded through all scopes; precedent #25 invariant
  // (no file content attachment) preserved — `prompt` is a short directive
  // only, never the file body.
  expect(buildClaudeUrl({ mode: 'cowork' }, payload())).toBe(
    'claude://cowork/new?q=open%20this&folder=%2FUsers%2Fwho%2Fproj',
  );
});

test('buildClaudeUrl threads prompt for doc-scoped code as q=<prompt>&folder=<projectDir>', () => {
  expect(buildClaudeUrl({ mode: 'code' }, payload({ target: 'claude-code' }))).toBe(
    'claude://code/new?q=open%20this&folder=%2FUsers%2Fwho%2Fproj',
  );
});

test('buildClaudeUrl single-encodes literal % in projectDir (cowork)', () => {
  const url = buildClaudeUrl(
    { mode: 'cowork' },
    payload({
      projectDir: '/Users/who/My %Project',
      docPath: '/Users/who/My %Project/a.md',
    }),
  );
  expect(url).toContain('folder=%2FUsers%2Fwho%2FMy%20%25Project');
  // precedent #25 invariant: never threads file content / docPath bytes.
  expect(url).not.toContain('file=');
});

test('buildClaudeUrl precedent #25: docPath bytes never leak into URL (em-dash, code)', () => {
  // docPath bytes (including em-dash U+2014) must not appear in the URL —
  // the doc-scoped path threads the PROMPT (which the caller composes), not
  // the docPath bytes themselves. precedent #25 invariant preserved.
  const url = buildClaudeUrl(
    { mode: 'code' },
    payload({
      target: 'claude-code',
      docPath: '/Users/who/proj/café — notes.md',
      prompt: 'simple prompt',
    }),
  );
  expect(url).not.toContain('file=');
  // %E2%80%94 = em-dash encoded; docPath must not leak through any param.
  expect(url).not.toContain('%E2%80%94');
});

test('buildClaudeUrl precedent #25: docPath bytes never leak into URL (unicode, cowork)', () => {
  const url = buildClaudeUrl(
    { mode: 'cowork' },
    payload({ docPath: '/Users/who/proj/café-notes.md', prompt: 'simple prompt' }),
  );
  expect(url).not.toContain('file=');
  expect(url).not.toContain('caf%C3%A9');
});

test('buildClaudeUrl single-encodes space in projectDir (code)', () => {
  const url = buildClaudeUrl(
    { mode: 'code' },
    payload({
      target: 'claude-code',
      projectDir: '/Users/who/My Project',
      docPath: '/Users/who/My Project/README.md',
    }),
  );
  expect(url).toContain('folder=%2FUsers%2Fwho%2FMy%20Project');
  expect(url).not.toContain('file=');
});

test('buildClaudeUrl single-encodes literal & in projectDir (cowork) — DC8.5', () => {
  const url = buildClaudeUrl(
    { mode: 'cowork' },
    payload({
      projectDir: '/Users/who/A & B',
      docPath: '/Users/who/A & B/doc.md',
      prompt: 'hi',
    }),
  );
  expect(url).toContain('folder=%2FUsers%2Fwho%2FA%20%26%20B');
  expect(url).not.toContain('file=');
  // q=hi&folder=… — exactly one literal & (q→folder separator). projectDir's
  // & contributes none after single-encoding.
  expect(url.split('&').length - 1).toBe(1);
});

test('buildClaudeUrl precedent #25: docPath bytes never leak into URL (# in docPath, code) — DC8.5', () => {
  const url = buildClaudeUrl(
    { mode: 'code' },
    payload({
      target: 'claude-code',
      docPath: '/Users/who/proj/notes#1.md',
      prompt: 'simple prompt',
    }),
  );
  expect(url).not.toContain('file=');
  // No bare # in the URL (would terminate the query string otherwise);
  // docPath bytes don't appear at all.
  expect(url.includes('#')).toBe(false);
});

test('buildClaudeUrl single-encodes Windows backslash projectDir (cowork) — DC8.5', () => {
  const url = buildClaudeUrl(
    { mode: 'cowork' },
    payload({
      projectDir: 'C:\\Users\\who\\proj',
      docPath: 'C:\\Users\\who\\proj\\docs\\note.md',
    }),
  );
  expect(url).toContain('folder=C%3A%5CUsers%5Cwho%5Cproj');
  expect(url).not.toContain('file=');
});

test('buildClaudeUrl empty-prompt defensive fallback drops q=, keeps folder (doc-scoped)', () => {
  // The empty-prompt fallback is a defensive sub-branch; no production caller
  // emits an empty prompt today. Doc-scoped with empty prompt → cwd-only URL.
  const url = buildClaudeUrl({ mode: 'cowork' }, payload({ prompt: '' }));
  expect(url).toBe('claude://cowork/new?folder=%2FUsers%2Fwho%2Fproj');
  expect(url).not.toContain('q=');
  expect(url).not.toContain('file=');
});

test('buildClaudeUrl empty-prompt defensive fallback drops q=, keeps folder (project-scoped)', () => {
  const url = buildClaudeUrl({ mode: 'cowork' }, payload({ prompt: '', docPath: '' }));
  expect(url).toBe('claude://cowork/new?folder=%2FUsers%2Fwho%2Fproj');
  expect(url).not.toContain('q=');
  expect(url).not.toContain('file=');
});

test('buildClaudeUrl empty-prompt fallback applies to code mode as well', () => {
  const url = buildClaudeUrl(
    { mode: 'code' },
    payload({ target: 'claude-code', prompt: '', docPath: '' }),
  );
  expect(url).toBe('claude://code/new?folder=%2FUsers%2Fwho%2Fproj');
});

test('buildClaudeUrl project-scoped (composeEmptySpacePrompt + empty docPath) emits q + folder, no file', () => {
  // Project-scoped path: empty docPath ⇒ q= for the project prompt + folder=
  // for the vault root. Pin the composition seam.
  const prompt = composeEmptySpacePrompt(true);
  const url = buildClaudeUrl({ mode: 'cowork' }, payload({ prompt, docPath: '' }));
  expect(url).toBe(
    `claude://cowork/new?q=${encodeURIComponent(prompt)}&folder=%2FUsers%2Fwho%2Fproj`,
  );
  expect(url).not.toContain('file=');
});

test('INVARIANT: buildClaudeUrl threads prompt through ALL scopes; precedent #25 = no file=', () => {
  // prompt is threaded through every scope. precedent #25 invariant
  // (no file content attachment) is preserved by virtue of the URL never
  // carrying `file=` — the prompt is a short directive composed by the caller,
  // never the file body. Covers both modes and a representative set of
  // docPath / prompt / projectDir variations.
  const cases: ReadonlyArray<{
    projectDir: string;
    docPath: string;
    prompt: string;
  }> = [
    { projectDir: '/Users/a/proj', docPath: '/Users/a/proj/a.md', prompt: 'hi' },
    {
      projectDir: '/Users/a/proj',
      docPath: '/Users/a/proj/sub/x.md',
      prompt: 'longer prompt with spaces',
    },
    {
      projectDir: '/Users/a/My Project',
      docPath: '/Users/a/My Project/note.md',
      prompt: 'x',
    },
    { projectDir: '/Users/a/A & B', docPath: '/Users/a/A & B/doc.md', prompt: 'x' },
    {
      projectDir: '/Users/a/proj',
      docPath: '/Users/a/proj/café — notes.md',
      prompt: 'x',
    },
    {
      projectDir: 'C:\\Users\\a\\proj',
      docPath: 'C:\\Users\\a\\proj\\d.md',
      prompt: 'x',
    },
    { projectDir: '/Users/a/proj', docPath: '/Users/a/proj/notes#1.md', prompt: 'x' },
  ];
  for (const c of cases) {
    for (const mode of ['cowork', 'code'] as const) {
      const target: HandoffPayload['target'] = mode === 'cowork' ? 'claude-cowork' : 'claude-code';
      const url = buildClaudeUrl(
        { mode },
        { target, projectDir: c.projectDir, docPath: c.docPath, prompt: c.prompt },
      );
      // precedent #25 invariant — no native file-attach.
      expect(url).not.toContain('file=');
      // prompt is threaded for all non-empty prompts.
      expect(url).toContain('q=');
      expect(url).toContain('folder=');
    }
  }
});

test('INVARIANT: buildClaudeUrl empty-prompt fallback drops q= across input variations', () => {
  // Defensive empty-prompt fallback: when prompt === '', URL builders emit
  // cwd-only. No production caller emits empty prompt today; this pins the
  // contract so a future refactor that drops the empty-prompt branch fails
  // here.
  const cases: ReadonlyArray<{
    projectDir: string;
    docPath: string;
  }> = [
    { projectDir: '/Users/a/proj', docPath: '/Users/a/proj/a.md' },
    { projectDir: '/Users/a/proj', docPath: '' },
    { projectDir: '/Users/a/A & B', docPath: '' },
    { projectDir: 'C:\\Users\\a\\proj', docPath: 'C:\\Users\\a\\proj\\d.md' },
  ];
  for (const c of cases) {
    for (const mode of ['cowork', 'code'] as const) {
      const target: HandoffPayload['target'] = mode === 'cowork' ? 'claude-cowork' : 'claude-code';
      const url = buildClaudeUrl(
        { mode },
        { target, projectDir: c.projectDir, docPath: c.docPath, prompt: '' },
      );
      expect(url).not.toContain('q=');
      expect(url).not.toContain('file=');
      expect(url).toContain('folder=');
    }
  }
});
