import { describe, expect, test } from 'vitest';
import { diffFrontmatter } from './frontmatter-diff.ts';

function doc(yaml: string, body = 'Body text.\n'): string {
  return `---\n${yaml}\n---\n${body}`;
}

describe('diffFrontmatter — change kinds', () => {
  test('reports a scalar value change', () => {
    const delta = diffFrontmatter(doc('status: draft'), doc('status: ready'));
    expect(delta.changes).toEqual([
      { key: 'status', kind: 'changed', before: 'draft', after: 'ready' },
    ]);
    expect(delta.changes).toHaveLength(1);
    expect(delta.unparseable).toBeNull();
  });

  test('reports an added key', () => {
    const delta = diffFrontmatter(doc('status: draft'), doc('status: draft\nreviewer: shagun'));
    expect(delta.changes).toEqual([{ key: 'reviewer', kind: 'added', after: 'shagun' }]);
  });

  test('reports a removed key', () => {
    const delta = diffFrontmatter(doc('status: draft\ndue: 2026-08-01'), doc('status: draft'));
    expect(delta.changes).toEqual([{ key: 'due', kind: 'removed', before: '2026-08-01' }]);
  });

  test('orders after-side source order first, then removed keys', () => {
    const delta = diffFrontmatter(
      doc('title: a\ndropped: gone\nstatus: draft'),
      doc('status: ready\ntitle: a\nadded: new'),
    );
    expect(delta.changes.map((c) => [c.key, c.kind])).toEqual([
      ['status', 'changed'],
      ['added', 'added'],
      ['dropped', 'removed'],
    ]);
  });

  test('identical frontmatter reports no changes', () => {
    const same = doc('status: draft\ntags:\n  - a\n  - b');
    expect(diffFrontmatter(same, same).changes).toEqual([]);
  });

  test('body-only edits report no property changes', () => {
    const before = doc('status: draft', 'One.\n');
    const after = doc('status: draft', 'One.\n\nTwo.\n');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });
});

describe('diffFrontmatter — reserialization is not a change', () => {
  test('key reorder reports no changes', () => {
    const before = doc('title: Spec\nstatus: draft\nowner: shagun');
    const after = doc('owner: shagun\ntitle: Spec\nstatus: draft');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });

  test('requoting reports no changes', () => {
    const before = doc(`title: "Spec"\nowner: 'shagun'`);
    const after = doc('title: Spec\nowner: shagun');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });

  test('block/flow list restyle reports no changes', () => {
    const before = doc('tags:\n  - alpha\n  - beta');
    const after = doc('tags: [alpha, beta]');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });

  test('fence whitespace and trailing newlines report no changes', () => {
    const before = '---\nstatus: draft\n---\nBody.\n';
    const after = '---\nstatus: draft\n\n---\nBody.\n';
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });

  test('a comment added to the region is not a property change', () => {
    const before = doc('status: draft');
    const after = doc('# tracked in the spec\nstatus: draft');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });
});

describe('diffFrontmatter — nested values', () => {
  test('a deep change inside a nested object is one changed row', () => {
    const before = doc('meta:\n  owner: shagun\n  tier: 1');
    const after = doc('meta:\n  owner: shagun\n  tier: 2');
    const delta = diffFrontmatter(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ key: 'meta', kind: 'changed' });
  });

  test('a structurally identical nested object reports no change', () => {
    const before = doc('meta:\n  owner: shagun\n  tier: 1');
    const after = doc('meta: { owner: shagun, tier: 1 }');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });

  test('array element order is a change', () => {
    const before = doc('tags:\n  - a\n  - b');
    const after = doc('tags:\n  - b\n  - a');
    expect(diffFrontmatter(before, after).changes).toHaveLength(1);
  });

  test('an array of objects compares element-wise', () => {
    const before = doc('links:\n  - href: /a\n    label: A');
    const after = doc('links:\n  - href: /a\n    label: B');
    expect(diffFrontmatter(before, after).changes).toMatchObject([
      { key: 'links', kind: 'changed' },
    ]);
  });
});

describe('diffFrontmatter — regions that are absent or malformed', () => {
  test('no frontmatter on either side reports no changes', () => {
    const delta = diffFrontmatter('Just a body.\n', 'Just a different body.\n');
    expect(delta.changes).toEqual([]);
    expect(delta.unparseable).toBeNull();
  });

  test('adding a first frontmatter block reports every key as added', () => {
    const delta = diffFrontmatter('Body.\n', doc('status: draft\nowner: shagun'));
    expect(delta.changes.map((c) => [c.key, c.kind])).toEqual([
      ['status', 'added'],
      ['owner', 'added'],
    ]);
  });

  test('deleting the frontmatter block reports every key as removed', () => {
    const delta = diffFrontmatter(doc('status: draft\nowner: shagun'), 'Body.\n');
    expect(delta.changes.map((c) => [c.key, c.kind])).toEqual([
      ['status', 'removed'],
      ['owner', 'removed'],
    ]);
  });

  test('an empty frontmatter block is an empty map, not a parse failure', () => {
    const delta = diffFrontmatter('---\n---\nBody.\n', doc('status: draft'));
    expect(delta.unparseable).toBeNull();
    expect(delta.changes).toEqual([{ key: 'status', kind: 'added', after: 'draft' }]);
  });

  test('malformed YAML on the after side degrades to unparseable, never to silence', () => {
    const before = doc('status: draft');
    const after = doc('status: [unclosed');
    const delta = diffFrontmatter(before, after);
    expect(delta.changes).toEqual([]);

    expect(delta.unparseable).not.toBeNull();
    expect(delta.unparseable?.before).toContain('status: draft');
    expect(delta.unparseable?.after).toContain('status: [unclosed');
  });

  test('malformed YAML on the before side degrades to unparseable', () => {
    const delta = diffFrontmatter(doc('status: [unclosed'), doc('status: ready'));
    expect(delta.unparseable).not.toBeNull();
  });

  test('a non-mapping top-level region is unparseable', () => {
    const delta = diffFrontmatter(doc('- just\n- a\n- list'), doc('status: ready'));
    expect(delta.unparseable).not.toBeNull();
  });
});

describe('diffFrontmatter — duplicate keys', () => {
  test('reports one row per name even when the name appears twice', () => {
    const before = doc('status: draft\nstatus: stale');
    const after = doc('status: ready\nstatus: fresh');
    const delta = diffFrontmatter(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]?.key).toBe('status');
  });

  test('compares the value the parse resolved, not the first occurrence', () => {
    const before = doc('status: draft\nstatus: stale');
    const after = doc('status: ready\nstatus: stale');
    expect(diffFrontmatter(before, after).changes).toEqual([]);
  });
});
