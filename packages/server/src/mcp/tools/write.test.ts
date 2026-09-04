import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { splitPayloadFrontmatter } from '../../payload-frontmatter.ts';
import { composeWithFrontmatter, frontmatterIgnoredNote } from './write.ts';

function frontmatterBlockCount(markdown: string): number {
  let remaining = markdown;
  let count = 0;
  while (true) {
    const { frontmatter, body } = stripFrontmatter(remaining);
    if (frontmatter === '') break;
    count += 1;
    remaining = body;
  }
  return count;
}

describe('composeWithFrontmatter', () => {
  it('composes a single block from a plain body + param (frontmatter-only path)', () => {
    const result = composeWithFrontmatter({ title: 'Hello', tags: ['demo'] }, '# Hello\n\nBody.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(1);
    expect(result.markdown).toContain('title: Hello');
    expect(result.markdown.endsWith('# Hello\n\nBody.')).toBe(true);
  });

  it('PRD-6997: does NOT stack a second block when content already has one', () => {
    const content = '---\ntitle: Doubled FM\ntags: [demo]\n---\n\n# Doubled FM\n\nReal body line.';
    const result = composeWithFrontmatter({ title: 'Doubled FM', tags: ['demo'] }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(1);
    expect(result.markdown).toContain('# Doubled FM');
    expect(result.markdown).toContain('Real body line.');
  });

  it('merges embedded + param with the param winning on conflicting keys', () => {
    const content = '---\ntitle: Embedded\nauthor: HeeGun\n---\n\nBody.';
    const result = composeWithFrontmatter({ title: 'Param' }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(1);
    const { frontmatter } = stripFrontmatter(result.markdown);
    expect(frontmatter).toContain('title: Param');
    expect(frontmatter).toContain('author: HeeGun');
    expect(frontmatter).not.toContain('Embedded');
  });

  it('rejects a malformed embedded block instead of doubling', () => {
    const content = '---\ntitle: [unterminated\n---\n\nBody.';
    const result = composeWithFrontmatter({ title: 'Param' }, content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('EMBEDDED_FRONTMATTER_MALFORMED');
  });

  it('drops the block entirely when the merged result is empty', () => {
    const result = composeWithFrontmatter({ title: '' }, 'Just a body, no block.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(0);
    expect(result.markdown).toBe('Just a body, no block.');
  });

  it('a param empty value clears a conflicting embedded key', () => {
    const content = '---\ntitle: Keep\nstatus: draft\n---\n\nBody.';
    const result = composeWithFrontmatter({ status: '' }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { frontmatter } = stripFrontmatter(result.markdown);
    expect(frontmatter).toContain('title: Keep');
    expect(frontmatter).not.toContain('status');
  });

  it('a param null value clears a conflicting embedded key (RFC 7396 delete sentinel)', () => {
    const content = '---\ntitle: Keep\nstatus: draft\n---\n\nBody.';
    const result = composeWithFrontmatter({ status: null }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { frontmatter } = stripFrontmatter(result.markdown);
    expect(frontmatter).toContain('title: Keep');
    expect(frontmatter).not.toContain('status');
  });

  it('strips the embedded block entirely when the param clears its only key', () => {
    const content = '---\nstatus: draft\n---\n\nBody.';
    const result = composeWithFrontmatter({ status: null }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(0);
    expect(result.markdown).toBe('\nBody.');
  });
});

describe('splitPayloadFrontmatter — the shared append/prepend partition rule', () => {
  it('treats a `---`-fenced NON-mapping span as body, so no drop is announced', () => {
    const payload = '---\n\n## Findings\n\n---\n\nTrailing note.\n';
    const split = splitPayloadFrontmatter(payload);
    expect(split.frontmatter).toBe('');
    expect(split.body).toBe(payload);
  });

  it('still partitions a real YAML-mapping block off the payload', () => {
    const split = splitPayloadFrontmatter('---\ntitle: Second\n---\n\nExtra.\n');
    expect(split.frontmatter).toBe('---\ntitle: Second\n---\n');
    expect(split.body).toBe('\nExtra.\n');
  });

  it('leaves a payload with no leading fence untouched', () => {
    const split = splitPayloadFrontmatter('Just a paragraph.\n');
    expect(split.frontmatter).toBe('');
    expect(split.body).toBe('Just a paragraph.\n');
  });
});

describe('frontmatterIgnoredNote — the two outcomes are distinguishable', () => {
  const dropped = frontmatterIgnoredNote('append', '---\ntitle: Fine\n---\nbody\n');
  const asBody = frontmatterIgnoredNote('append', '---\ntitle: Foo: Bar\n---\nbody\n');

  it('says DROPPED for a well-formed mapping', () => {
    expect(dropped).toContain('was ignored');
    expect(dropped).not.toContain('written as BODY');
  });

  it('says WRITTEN AS BODY for a span that is not a mapping', () => {
    expect(asBody).toContain('written as BODY');
    expect(asBody).toContain('not a YAML mapping');
  });

  it('stays silent when the payload never opened with a fence pair', () => {
    expect(frontmatterIgnoredNote('append', 'just a paragraph\n')).toBeNull();
    expect(frontmatterIgnoredNote('append', '---\njust a break\n')).toBeNull();
  });

  it('stays silent on replace, which does not drop anything', () => {
    expect(frontmatterIgnoredNote('replace', '---\ntitle: Fine\n---\nbody\n')).toBeNull();
  });
});
