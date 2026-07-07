import { describe, expect, test } from 'bun:test';
import {
  extractPageAliases,
  extractPageIcon,
  extractPageIdentity,
  extractPageTitle,
  parseFrontmatterMetadata,
} from './page-identity.ts';

describe('extractPageIdentity', () => {
  test('uses frontmatter title and aliases as reusable match labels', () => {
    const content = [
      '---',
      'title: Project Alpha',
      'aliases:',
      '  - Alpha Project',
      '  - "Project, A"',
      '---',
      '',
      '# Different Heading',
      '',
      'Body.',
    ].join('\n');

    expect(extractPageIdentity(content, 'project-alpha')).toEqual({
      docName: 'project-alpha',
      title: 'Project Alpha',
      aliases: ['Alpha Project', 'Project, A'],
      matchLabels: ['Project Alpha', 'Alpha Project', 'Project, A'],
      normalizedMatchLabels: ['project-alpha', 'alpha-project', 'project-a'],
    });
  });

  test('reuses shared slug normalization for match-label comparisons', () => {
    const content = [
      '---',
      'title: Café Menu',
      'aliases:',
      '  - Cafe Menu',
      '  - 東京 2026',
      '---',
      '',
      'Body.',
    ].join('\n');

    expect(extractPageIdentity(content, 'cafe-menu')).toEqual({
      docName: 'cafe-menu',
      title: 'Café Menu',
      aliases: ['Cafe Menu', '東京 2026'],
      matchLabels: ['Café Menu', 'Cafe Menu', '東京 2026'],
      normalizedMatchLabels: ['cafe-menu', '東京-2026'],
    });
  });
});

describe('extractPageIdentity — fence trailing whitespace (fm-delimiter hazard)', () => {
  test('title and aliases survive trailing spaces on both fence lines', () => {
    // `--- ` is one in-tolerance source-mode keystroke away from `---`;
    // identity extraction must keep partitioning the FM region as FM
    // instead of falling through to the body heading.
    const content = [
      '--- ',
      'title: Project Alpha',
      'aliases:',
      '  - Alpha Project',
      '--- ',
      '',
      '# Different Heading',
      '',
      'Body.',
    ].join('\n');

    const identity = extractPageIdentity(content, 'project-alpha');
    expect(identity.title).toBe('Project Alpha');
    expect(identity.aliases).toEqual(['Alpha Project']);
    expect(identity.matchLabels).toEqual(['Project Alpha', 'Alpha Project']);
  });

  test('extractPageTitle reads the frontmatter title under a trailing-tab closing fence', () => {
    const content = '---\ntitle: Tab Fence\n---\t\n\nBody.';
    expect(extractPageTitle(content, 'fallback-name')).toBe('Tab Fence');
  });

  test('a leading space before the opening fence still disqualifies the block', () => {
    const content = ' ---\ntitle: Not FM\n---\n\n# Heading\n';
    expect(extractPageTitle(content, 'fallback-name')).toBe('Heading');
  });
});

describe('extractPageAliases', () => {
  test('supports inline alias arrays and exact deduplication', () => {
    const content = ['---', 'aliases: ["Alpha", "Project, A", "Alpha"]', '---', '', 'Body.'].join(
      '\n',
    );

    expect(extractPageAliases(content)).toEqual(['Alpha', 'Project, A']);
  });
});

describe('parseFrontmatterMetadata', () => {
  test('extracts all fields from valid frontmatter', () => {
    const raw = [
      '---',
      'title: Vector Search',
      'description: How vector search works',
      'tags: [retrieval, embeddings, ANN]',
      'category: method',
      'cluster: retrieval',
      '---',
    ].join('\n');

    expect(parseFrontmatterMetadata(raw)).toEqual({
      cluster: 'retrieval',
      category: 'method',
      tags: ['retrieval', 'embeddings', 'ANN'],
    });
  });

  test('returns undefined for missing individual fields', () => {
    const raw = ['---', 'title: Some Page', 'cluster: planning', '---'].join('\n');

    const result = parseFrontmatterMetadata(raw);
    expect(result.cluster).toBe('planning');
    expect(result.category).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  test('handles block array syntax for tags', () => {
    const raw = [
      '---',
      'tags:',
      '  - memory',
      '  - consolidation',
      '  - long-term',
      'category: concept',
      '---',
    ].join('\n');

    const result = parseFrontmatterMetadata(raw);
    expect(result.tags).toEqual(['memory', 'consolidation', 'long-term']);
    expect(result.category).toBe('concept');
  });

  test('handles inline array syntax for tags', () => {
    const raw = ['---', 'tags: [sparse, dense, hybrid]', 'cluster: retrieval', '---'].join('\n');

    expect(parseFrontmatterMetadata(raw).tags).toEqual(['sparse', 'dense', 'hybrid']);
  });

  test('handles empty frontmatter without throwing', () => {
    expect(parseFrontmatterMetadata('')).toEqual({
      cluster: undefined,
      category: undefined,
      tags: undefined,
    });

    expect(parseFrontmatterMetadata('---\n---')).toEqual({
      cluster: undefined,
      category: undefined,
      tags: undefined,
    });
  });

  test('handles malformed YAML without throwing', () => {
    const raw = '---\nthis is not: valid: yaml: at all\n---';
    const result = parseFrontmatterMetadata(raw);
    expect(result.cluster).toBeUndefined();
    expect(result.category).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  test('handles quoted scalar values', () => {
    const raw = ['---', 'cluster: "long-term-memory"', "category: 'concept'", '---'].join('\n');

    expect(parseFrontmatterMetadata(raw)).toEqual({
      cluster: 'long-term-memory',
      category: 'concept',
      tags: undefined,
    });
  });

  test('handles tags with quoted items', () => {
    const raw = ['---', 'tags: ["graph theory", \'knowledge bases\', plain]', '---'].join('\n');

    expect(parseFrontmatterMetadata(raw).tags).toEqual([
      'graph theory',
      'knowledge bases',
      'plain',
    ]);
  });

  test('returns undefined for empty tags array', () => {
    const raw = ['---', 'tags: []', '---'].join('\n');
    expect(parseFrontmatterMetadata(raw).tags).toBeUndefined();
  });

  test('handles frontmatter without delimiters', () => {
    const raw = 'cluster: evaluation\ncategory: benchmark';
    const result = parseFrontmatterMetadata(raw);
    expect(result.cluster).toBe('evaluation');
    expect(result.category).toBe('benchmark');
  });
});

describe('extractPageTitle', () => {
  test('falls through to the first body heading when frontmatter has no title', () => {
    const content = '---\nauthor: Alice\n---\n\n# First Heading\n\nBody.';

    expect(extractPageTitle(content, 'project-alpha')).toBe('First Heading');
  });

  test('falls through to the filename when there is no title or heading', () => {
    expect(extractPageTitle('Plain body text.', 'project-alpha')).toBe('project-alpha');
  });
});

describe('extractPageIcon', () => {
  test('returns the trimmed scalar emoji from frontmatter', () => {
    const content = '---\ntitle: Notes\nicon: 📝\n---\n\nBody.';
    expect(extractPageIcon(content)).toBe('📝');
  });

  test('returns a quoted scalar with surrounding quotes stripped', () => {
    const content = '---\nicon: "assets/banner.png"\n---\n\nBody.';
    expect(extractPageIcon(content)).toBe('assets/banner.png');
  });

  test('returns single-quoted scalars stripped of quotes', () => {
    const content = "---\nicon: 'https://example.com/img.png'\n---\n";
    expect(extractPageIcon(content)).toBe('https://example.com/img.png');
  });

  test('returns undefined when frontmatter lacks an icon key', () => {
    const content = '---\ntitle: Notes\n---\n\nBody.';
    expect(extractPageIcon(content)).toBeUndefined();
  });

  test('returns undefined when icon is set to an empty string', () => {
    const content = '---\nicon: ""\n---\n\nBody.';
    expect(extractPageIcon(content)).toBeUndefined();
  });

  test('returns undefined when the document has no frontmatter block', () => {
    expect(extractPageIcon('Plain body text.')).toBeUndefined();
  });

  test('does not match an icon key inside the body', () => {
    const content = '---\ntitle: Notes\n---\n\nicon: 🚫\n';
    expect(extractPageIcon(content)).toBeUndefined();
  });

  test('returns undefined when the icon scalar exceeds the 2048-char cap', () => {
    // Server-side cap matches `PageEntrySchema.icon.max(2048)` and the
    // client classifier's `MAX_VALUE_LENGTH`. Without it, a 3000-char
    // scalar on a single doc would 500 the entire `/api/pages` listing
    // via `successResponse`'s `safeParse`.
    const oversized = 'x'.repeat(3000);
    const content = `---\nicon: ${oversized}\n---\n`;
    expect(extractPageIcon(content)).toBeUndefined();
  });

  test('accepts an icon scalar exactly at the 2048-char cap', () => {
    const exactlyAtCap = 'x'.repeat(2048);
    const content = `---\nicon: ${exactlyAtCap}\n---\n`;
    expect(extractPageIcon(content)).toBe(exactlyAtCap);
  });

  test('returns undefined when icon holds a nested map (graceful degradation)', () => {
    // Recursive frontmatter values are now representable upstream, but the
    // regex scalar reader is intentionally not a YAML parser — it sees an
    // empty inline value on the `icon:` line and returns undefined. The
    // load-bearing posture: never crash on a shape it can't read.
    const content = '---\nicon:\n  url: https://example.com/img.png\n  alt: example\n---\n';
    expect(extractPageIcon(content)).toBeUndefined();
  });
});
