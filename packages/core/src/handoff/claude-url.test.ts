import { expect, test } from 'vitest';
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
  const url = buildClaudeUrl(
    { mode: 'code' },
    payload({
      target: 'claude-code',
      docPath: '/Users/who/proj/café — notes.md',
      prompt: 'simple prompt',
    }),
  );
  expect(url).not.toContain('file=');
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
  const prompt = composeEmptySpacePrompt(true);
  const url = buildClaudeUrl({ mode: 'cowork' }, payload({ prompt, docPath: '' }));
  expect(url).toBe(
    `claude://cowork/new?q=${encodeURIComponent(prompt)}&folder=%2FUsers%2Fwho%2Fproj`,
  );
  expect(url).not.toContain('file=');
});

test('INVARIANT: buildClaudeUrl threads prompt through ALL scopes; precedent #25 = no file=', () => {
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
      expect(url).toContain('q=');
      expect(url).toContain('folder=');
    }
  }
});

test('INVARIANT: buildClaudeUrl empty-prompt fallback drops q= across input variations', () => {
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
