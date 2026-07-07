/**
 * Unit coverage for `composeWithFrontmatter` — the inline YAML-block composer
 * used when `write({ document })` carries both literal `content` and a
 * `frontmatter` param.
 *
 * when `content` already opened with its own
 * `---…---` block AND a `frontmatter` param was supplied, the composer
 * prepended a SECOND block, stacking two frontmatter blocks on disk. The fix
 * merges the embedded block with the param (param wins) into a single block.
 */
import { describe, expect, it } from 'bun:test';
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { composeWithFrontmatter } from './write.ts';

/** Count leading-or-anywhere `---` fence lines that open a frontmatter block. */
function frontmatterBlockCount(markdown: string): number {
  // A doubled block is `---\n…---\n---\n…---`. Re-strip after removing the
  // first block; a second strip that still finds a block means doubling.
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
    // The bug produced 2; the fix must produce exactly 1.
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
    expect(frontmatter).toContain('title: Param'); // param wins
    expect(frontmatter).toContain('author: HeeGun'); // embedded-only key survives
    expect(frontmatter).not.toContain('Embedded'); // overwritten title gone
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
    // Distinct from the plain-body empty-merge case: here an embedded block
    // exists but every key it carries is cleared, so the fence is removed too.
    const content = '---\nstatus: draft\n---\n\nBody.';
    const result = composeWithFrontmatter({ status: null }, content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(frontmatterBlockCount(result.markdown)).toBe(0);
    expect(result.markdown).toBe('\nBody.');
  });
});
