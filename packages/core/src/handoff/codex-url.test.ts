import { expect, test } from 'bun:test';
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
  // Prompt threaded through all scopes; precedent #25 invariant
  // (no file content attachment) preserved — `prompt` is a short directive,
  // never the file body. Mirrors claude-url + cursor-url symmetry.
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
  // The prompt is threaded — verify encoding of em-dash (U+2014)
  // and unicode (é) round-trips correctly via single-encoding.
  const url = buildCodexUrl(payload({ prompt: 'Read café — notes about the feature' }));
  expect(url).toContain('prompt=Read%20caf%C3%A9%20%E2%80%94%20notes%20about%20the%20feature');
  // precedent #25 invariant: no native file-attach.
  expect(url).not.toContain('file=');
});

test('buildCodexUrl single-encodes literal & in projectDir — DC8.5', () => {
  const url = buildCodexUrl(payload({ projectDir: '/Users/who/A & B' }));
  expect(url).toContain('path=%2FUsers%2Fwho%2FA%20%26%20B');
  expect(url).not.toContain('file=');
  // prompt=open%20this&path=… — exactly one literal & (prompt→path separator).
  expect(url.split('&').length - 1).toBe(1);
});

test('buildCodexUrl precedent #25: docPath bytes never thread into URL', () => {
  // The doc-scoped path threads the PROMPT, not the docPath bytes. Verifies
  // the precedent #25 invariant: no `file=` attach, docPath specific bytes
  // don't appear (the prompt the caller composes may name the file, but the
  // file param `file=` never appears).
  const url = buildCodexUrl(payload({ docPath: '/Users/who/proj/docs/SPECIFIC-FILE.md' }));
  expect(url).not.toContain('SPECIFIC-FILE');
  expect(url).not.toContain('file=');
});

test('buildCodexUrl empty-prompt defensive fallback drops prompt= and keeps path=', () => {
  // The empty-prompt fallback is a defensive sub-branch; no production caller
  // emits an empty prompt today — project-scoped handoffs compose via
  // `composeEmptySpacePrompt(true)`. Pins the defensive fallback so the URL builder
  // stays correct if a future caller does emit ''.
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
  // Pin the composition seam (prompt value → URL encoding → final URL) so a
  // future change to either `composeEmptySpacePrompt` or `buildCodexUrl` that
  // introduces an encoding regression fails here.
  const prompt = composeEmptySpacePrompt(true);
  const url = buildCodexUrl(payload({ prompt, docPath: '' }));
  expect(url).toBe(`codex://new?prompt=${encodeURIComponent(prompt)}&path=%2FUsers%2Fwho%2Fproj`);
});

test('INVARIANT: buildCodexUrl threads prompt through ALL scopes; precedent #25 = no file=', () => {
  // Prompt is threaded through every scope. precedent #25 invariant
  // (no file content attachment) is preserved by virtue of the URL never
  // carrying `file=`. Mirrors claude-url.test.ts's INVARIANT pattern;
  // applied symmetrically across all three native handoff URL builders.
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
    // prompt is threaded for all non-empty prompts.
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
