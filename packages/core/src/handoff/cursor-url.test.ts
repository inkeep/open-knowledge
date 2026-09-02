import { expect, test } from 'vitest';
import { buildCursorUrl } from './cursor-url.ts';
import { composeEmptySpacePrompt } from './prompt-composer.ts';
import type { HandoffPayload } from './types.ts';

function payload(overrides: Partial<HandoffPayload> = {}): HandoffPayload {
  return {
    target: 'cursor',
    projectDir: '/Users/who/proj',
    docPath: '/Users/who/proj/docs/note.md',
    prompt: 'open this',
    ...overrides,
  };
}

test('buildCursorUrl threads double-encoded prompt for doc-scoped as text=<dbl-enc>&workspace=<basename>&mode=agent', () => {
  expect(buildCursorUrl(payload())).toBe(
    'cursor://anysphere.cursor-deeplink/prompt?text=open%2520this&workspace=proj&mode=agent',
  );
});

test('buildCursorUrl doc-scoped double-encodes prompt containing literal %', () => {
  const url = buildCursorUrl(payload({ prompt: 'a%b' }));
  expect(url).toContain('text=a%2525b');
  // precedent #25 invariant: no native file-attach.
  expect(url).not.toContain('file=');
});

test('buildCursorUrl doc-scoped double-encodes prompt containing em-dash', () => {
  const url = buildCursorUrl(payload({ prompt: 'a — b' }));
  expect(url).toContain('text=a%2520%25E2%2580%2594%2520b');
  expect(url).not.toContain('file=');
});

test('buildCursorUrl doc-scoped double-encodes prompt containing literal %41', () => {
  const url = buildCursorUrl(payload({ prompt: 'check %41 please' }));
  expect(url).toContain('text=check%2520%252541%2520please');
  expect(url).not.toContain('file=');
});

test('buildCursorUrl doc-scoped double-encodes prompt containing a pct-encoded URL', () => {
  const url = buildCursorUrl(payload({ prompt: 'see https://example.com/p?q=a%20b' }));
  const text = url.match(/text=([^&]+)/)?.[1];
  expect(text).toBeDefined();
  expect(decodeURIComponent(decodeURIComponent(text as string))).toBe(
    'see https://example.com/p?q=a%20b',
  );
  expect(url).not.toContain('file=');
});

test('buildCursorUrl doc-scoped double-encodes & in prompt — DC8.5', () => {
  const url = buildCursorUrl(payload({ prompt: 'A & B' }));
  expect(url).toContain('text=A%2520%2526%2520B');
  expect(url.split('&').length - 1).toBe(2);
});

test('buildCursorUrl takes basename of POSIX projectDir for workspace=', () => {
  const url = buildCursorUrl(payload({ projectDir: '/Users/who/projects/open-knowledge' }));
  expect(url).toBe(
    'cursor://anysphere.cursor-deeplink/prompt?text=open%2520this&workspace=open-knowledge&mode=agent',
  );
});

test('buildCursorUrl takes basename of Windows projectDir for workspace= — DC8.5', () => {
  const url = buildCursorUrl(payload({ projectDir: 'C:\\Users\\who\\projects\\open-knowledge' }));
  expect(url).toBe(
    'cursor://anysphere.cursor-deeplink/prompt?text=open%2520this&workspace=open-knowledge&mode=agent',
  );
});

test('buildCursorUrl single-encodes spaces in workspace basename', () => {
  const url = buildCursorUrl(payload({ projectDir: '/Users/who/My Project' }));
  expect(url).toBe(
    'cursor://anysphere.cursor-deeplink/prompt?text=open%2520this&workspace=My%20Project&mode=agent',
  );
});

test('buildCursorUrl mode= is the literal enum value (not encoded)', () => {
  const url = buildCursorUrl(payload());
  expect(url.endsWith('&mode=agent')).toBe(true);
});

test('buildCursorUrl empty-prompt defensive fallback drops text= and keeps workspace + mode', () => {
  const url = buildCursorUrl(payload({ prompt: '', docPath: '' }));
  expect(url).toBe('cursor://anysphere.cursor-deeplink/prompt?workspace=proj&mode=agent');
  expect(url).not.toContain('text=');
});

test('buildCursorUrl empty-prompt defensive fallback applies to doc-scoped too', () => {
  const url = buildCursorUrl(payload({ prompt: '' }));
  expect(url).toBe('cursor://anysphere.cursor-deeplink/prompt?workspace=proj&mode=agent');
  expect(url).not.toContain('text=');
});

test('buildCursorUrl project-scoped (composeEmptySpacePrompt) double-encodes prompt + keeps workspace + mode', () => {
  const prompt = composeEmptySpacePrompt(true);
  const url = buildCursorUrl(payload({ prompt, docPath: '' }));
  const doubleEncoded = encodeURIComponent(encodeURIComponent(prompt));
  expect(url).toBe(
    `cursor://anysphere.cursor-deeplink/prompt?text=${doubleEncoded}&workspace=proj&mode=agent`,
  );
});

test('buildCursorUrl project-scoped double-encodes adversarial prompt (round-trip invariant)', () => {
  const adversarialPrompt = 'check %41 and https://x.com/p?q=a%20b please';
  const url = buildCursorUrl(payload({ prompt: adversarialPrompt, docPath: '' }));
  const text = url.match(/text=([^&]+)/)?.[1];
  expect(text).toBeDefined();
  expect(decodeURIComponent(decodeURIComponent(text as string))).toBe(adversarialPrompt);
});

test('INVARIANT: buildCursorUrl threads double-encoded prompt through ALL scopes; precedent #25 = no file=', () => {
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
    const url = buildCursorUrl({
      target: 'cursor',
      projectDir: c.projectDir,
      docPath: c.docPath,
      prompt: c.prompt,
    });
    // precedent #25 invariant — no native file-attach.
    expect(url).not.toContain('file=');
    expect(url).toContain('text=');
    expect(url).toContain('workspace=');
    expect(url).toContain('mode=agent');
  }
});

test('INVARIANT: buildCursorUrl empty-prompt fallback drops text= across input variations', () => {
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
    const url = buildCursorUrl({
      target: 'cursor',
      projectDir: c.projectDir,
      docPath: c.docPath,
      prompt: '',
    });
    expect(url).not.toContain('text=');
    expect(url).toContain('workspace=');
    expect(url).toContain('mode=agent');
  }
});
