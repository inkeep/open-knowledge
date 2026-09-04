import { expect, test } from 'vitest';
import { buildCodexUrl } from './codex-url.ts';
import { composeEmptySpacePrompt } from './prompt-composer.ts';
import type { HandoffPayload } from './types.ts';

function payload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  return {
    target: 'codex',
    projectDir: '/Users/who/proj',
    docPath: '/Users/who/proj/docs/note.md',
    prompt: 'open this',
    ...overrides,
  };
}

test('buildCodexUrl threads prompt for doc-scoped as prompt=<prompt>&path=<projectDir>', () => {
  expect(buildCodexUrl(payload())).toBe(
    'codex://new?prompt=open%20this&path=%2FUsers%2Fwho%2Fproj',
  );
});

test('buildCodexUrl single-encodes % in projectDir', () => {
  const url = buildCodexUrl(payload({ projectDir: '/Users/who/My %Project' }));
  expect(url).toContain('path=%2FUsers%2Fwho%2FMy%20%25Project');
  // precedent #25 invariant: no `file=` attach.
  expect(url).not.toContain('file=');
});

test('buildCodexUrl threads em-dash + unicode prompt safely (precedent #25: no file=)', () => {
  const url = buildCodexUrl(payload({ prompt: 'Read café — notes about the feature' }));
  expect(url).toContain('prompt=Read%20caf%C3%A9%20%E2%80%94%20notes%20about%20the%20feature');
  // precedent #25 invariant: no native file-attach.
  expect(url).not.toContain('file=');
});

test('buildCodexUrl single-encodes literal & in projectDir — DC8.5', () => {
  const url = buildCodexUrl(payload({ projectDir: '/Users/who/A & B' }));
  expect(url).toContain('path=%2FUsers%2Fwho%2FA%20%26%20B');
  expect(url).not.toContain('file=');
  expect(url.split('&').length - 1).toBe(1);
});

test('buildCodexUrl precedent #25: docPath bytes never thread into URL', () => {
  const url = buildCodexUrl(payload({ docPath: '/Users/who/proj/docs/SPECIFIC-FILE.md' }));
  expect(url).not.toContain('SPECIFIC-FILE');
  expect(url).not.toContain('file=');
});

test('buildCodexUrl empty-prompt defensive fallback drops prompt= and keeps path=', () => {
  const url = buildCodexUrl(payload({ prompt: '', docPath: '' }));
  expect(url).toBe('codex://new?path=%2FUsers%2Fwho%2Fproj');
  expect(url).not.toContain('prompt=');
});

test('buildCodexUrl empty-prompt defensive fallback applies to doc-scoped too', () => {
  const url = buildCodexUrl(payload({ prompt: '' }));
  expect(url).toBe('codex://new?path=%2FUsers%2Fwho%2Fproj');
  expect(url).not.toContain('prompt=');
});

test('buildCodexUrl project-scoped (composeEmptySpacePrompt) includes encoded prompt + path', () => {
  const prompt = composeEmptySpacePrompt(true);
  const url = buildCodexUrl(payload({ prompt, docPath: '' }));
  expect(url).toBe(`codex://new?prompt=${encodeURIComponent(prompt)}&path=%2FUsers%2Fwho%2Fproj`);
});

test('INVARIANT: buildCodexUrl threads prompt through ALL scopes; precedent #25 = no file=', () => {
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
    const url = buildCodexUrl({
      target: 'codex',
      projectDir: c.projectDir,
      docPath: c.docPath,
      prompt: c.prompt,
    });
    // precedent #25 invariant — no native file-attach.
    expect(url).not.toContain('file=');
    expect(url).toContain('prompt=');
    expect(url).toContain('path=');
  }
});

test('INVARIANT: buildCodexUrl empty-prompt fallback drops prompt= across input variations', () => {
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
    const url = buildCodexUrl({
      target: 'codex',
      projectDir: c.projectDir,
      docPath: c.docPath,
      prompt: '',
    });
    expect(url).not.toContain('prompt=');
    expect(url).not.toContain('file=');
    expect(url).toContain('path=');
  }
});
