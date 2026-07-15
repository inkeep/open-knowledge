import { describe, expect, test } from 'bun:test';
import { extractDocExcerpt } from './doc-excerpt.ts';

describe('extractDocExcerpt', () => {
  test('strips markdown markup and returns readable prose', () => {
    const md = 'This has **bold**, _italic_, `code`, and a [link](https://example.com) inside.';
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toBe('This has bold, italic, code, and a link inside.');
  });

  test('skips a leading title heading and previews the opening body', () => {
    const md = '# Project Phoenix\n\nThe rollout plan for the new billing service.';
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toBe('The rollout plan for the new billing service.');
    expect(excerpt).not.toContain('Project Phoenix');
  });

  test('strips frontmatter before extracting the excerpt', () => {
    const md = '---\ntitle: Secret Title\ntags: [a, b]\n---\nVisible body prose here.';
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toBe('Visible body prose here.');
    expect(excerpt).not.toContain('Secret Title');
    expect(excerpt).not.toContain('tags');
  });

  test('returns an empty string for an empty body', () => {
    expect(extractDocExcerpt('')).toBe('');
    expect(extractDocExcerpt('---\ntitle: Only Frontmatter\n---\n')).toBe('');
    expect(extractDocExcerpt('# Heading Only\n')).toBe('');
  });

  test('skips fenced code blocks including hash lines inside them', () => {
    const md = ['```ts', '# not a heading', 'const x = 1;', '```', 'Real prose after code.'].join(
      '\n',
    );
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toBe('Real prose after code.');
    expect(excerpt).not.toContain('const x');
    expect(excerpt).not.toContain('not a heading');
  });

  test('gathers at most maxLines prose lines', () => {
    const md = 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.';
    const excerpt = extractDocExcerpt(md, { maxLines: 2 });
    expect(excerpt).toBe('Line one. Line two.');
    expect(excerpt).not.toContain('three');
  });

  test('bounds output for a very large single line', () => {
    const huge = 'word '.repeat(100_000);
    const excerpt = extractDocExcerpt(huge, { maxChars: 100 });
    expect(excerpt.length).toBeLessThanOrEqual(101);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  test('bounds output for a document with very many lines', () => {
    const md = Array.from({ length: 20_000 }, (_, i) => `Paragraph number ${i}.`).join('\n\n');
    const excerpt = extractDocExcerpt(md, { maxLines: 3, maxChars: 240 });
    expect(excerpt.length).toBeLessThanOrEqual(241);
    expect(excerpt).toContain('Paragraph number 0.');
    expect(excerpt).not.toContain('Paragraph number 19999.');
  });

  test('previews the referenced section for an anchor target', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '## Deployment',
      '',
      'Deploy with the blue-green strategy.',
      '',
      '## Rollback',
      '',
      'Roll back by promoting the previous release.',
    ].join('\n');
    const excerpt = extractDocExcerpt(md, { anchor: 'deployment' });
    expect(excerpt).toContain('Deployment');
    expect(excerpt).toContain('Deploy with the blue-green strategy.');
    expect(excerpt).not.toContain('Roll back');
    expect(excerpt).not.toContain('Intro paragraph.');
  });

  test('stops an anchor section at the next same-level heading but keeps subheadings', () => {
    const md = [
      '## Setup',
      '',
      'Install dependencies.',
      '',
      '### Prerequisites',
      '',
      'You need Node.',
      '',
      '## Teardown',
      '',
      'Remove everything.',
    ].join('\n');
    const excerpt = extractDocExcerpt(md, { anchor: 'setup', maxLines: 5 });
    expect(excerpt).toContain('Install dependencies.');
    expect(excerpt).toContain('You need Node.');
    expect(excerpt).not.toContain('Remove everything.');
  });

  test('falls back to the document head when the anchor does not resolve', () => {
    const md = '# Title\n\nHead prose paragraph.\n\n## Real Section\n\nSection body.';
    const excerpt = extractDocExcerpt(md, { anchor: 'nonexistent-anchor' });
    expect(excerpt).toBe('Head prose paragraph.');
  });

  test('renders wiki links, images, and list markers as plain text', () => {
    const md = '- See [[guides/install|the install guide]] and ![alt text](./img.png) here.';
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toContain('the install guide');
    expect(excerpt).toContain('alt text');
    expect(excerpt).not.toContain('[[');
    expect(excerpt).not.toContain('](');
    expect(excerpt.startsWith('-')).toBe(false);
  });

  test('skips thematic breaks between paragraphs', () => {
    const md = 'Alpha paragraph.\n\n---\n\nBravo paragraph.';
    const excerpt = extractDocExcerpt(md, { maxLines: 3 });
    expect(excerpt).toBe('Alpha paragraph. Bravo paragraph.');
    expect(excerpt).not.toContain('---');
  });

  test('preserves snake_case identifiers when stripping emphasis', () => {
    const md = 'The function is named handle_document_read in the server.';
    const excerpt = extractDocExcerpt(md);
    expect(excerpt).toContain('handle_document_read');
  });
});
