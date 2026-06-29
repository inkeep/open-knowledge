import { describe, expect, test } from 'bun:test';
import { classifyContextMenuTarget } from './asset-context-menu';

function makeEl(tag: string, attrs: Record<string, string> = {}): Element {
  const el = {
    tagName: tag.toUpperCase(),
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => attrs[name] ?? null,
    parentElement: null as Element | null,
  };
  return el as unknown as Element;
}

function chain(...els: Element[]): Element {
  const first = els[0];
  if (!first) throw new Error('chain requires at least one element');
  for (let i = 0; i < els.length - 1; i++) {
    const current = els[i];
    const next = els[i + 1];
    if (!current || !next) continue;
    (current as unknown as { parentElement: Element | null }).parentElement = next;
  }
  return first;
}

describe('classifyContextMenuTarget', () => {
  test('wiki-embed <a> → asset', () => {
    const a = makeEl('a', { 'data-wiki-embed': '', 'data-target': 'meeting.pdf' });
    expect(classifyContextMenuTarget(a, 'notes/readme')).toEqual({
      kind: 'asset',
      relPath: 'notes/meeting.pdf',
      title: 'meeting.pdf',
    });
  });

  test('wiki-embed <img> → image', () => {
    const img = makeEl('img', { 'data-wiki-embed': '', 'data-target': 'photo.png' });
    expect(classifyContextMenuTarget(img, 'notes/readme')).toEqual({
      kind: 'image',
      relPath: 'notes/photo.png',
      title: 'photo.png',
    });
  });

  test('wiki-link chip → wiki-link', () => {
    const span = makeEl('span', { 'data-wiki-link': '', 'data-target': 'guides/install' });
    expect(classifyContextMenuTarget(span, 'docs/readme')).toEqual({
      kind: 'wiki-link',
      relPath: 'guides/install.md',
      title: 'guides/install',
    });
  });

  test('plain <a href=./file.pdf> → asset (post-roundtrip or hand-authored)', () => {
    const a = makeEl('a', { href: './file.pdf' });
    expect(classifyContextMenuTarget(a, 'notes/readme')).toEqual({
      kind: 'asset',
      relPath: 'notes/file.pdf',
      title: 'file.pdf',
    });
  });

  test('plain <a href=./guide.md> → null (doc-link, not asset)', () => {
    const a = makeEl('a', { href: './guide.md' });
    expect(classifyContextMenuTarget(a, 'docs/readme')).toBeNull();
  });

  test('<img src=./photo.png> → image', () => {
    const img = makeEl('img', { src: './photo.png' });
    expect(classifyContextMenuTarget(img, 'notes/readme')).toEqual({
      kind: 'image',
      relPath: 'notes/photo.png',
      title: 'photo.png',
    });
  });

  test('<img src=https://example.com/photo.png> → null (external src, not an on-disk ref)', () => {
    const img = makeEl('img', { src: 'https://example.com/photo.png' });
    expect(classifyContextMenuTarget(img, 'notes/readme')).toBeNull();
  });

  test('span inside wiki-embed <a> walks up and matches', () => {
    const inner = makeEl('span');
    const outer = makeEl('a', { 'data-wiki-embed': '', 'data-target': 'archive.zip' });
    const el = chain(inner, outer);
    expect(classifyContextMenuTarget(el, 'notes/readme')).toEqual({
      kind: 'asset',
      relPath: 'notes/archive.zip',
      title: 'archive.zip',
    });
  });

  test('ordinary text span with no on-disk ancestor → null (browser default takes over)', () => {
    const inner = makeEl('span');
    const outer = makeEl('p');
    const el = chain(inner, outer);
    expect(classifyContextMenuTarget(el, 'notes/readme')).toBeNull();
  });

  test('wiki-embed with a path that escapes project root → null (defense-in-depth)', () => {
    const a = makeEl('a', { 'data-wiki-embed': '', 'data-target': '../../etc/passwd' });
    expect(classifyContextMenuTarget(a, 'notes/readme')).toBeNull();
  });

  test('wiki-embed with empty target → null', () => {
    const a = makeEl('a', { 'data-wiki-embed': '', 'data-target': '' });
    expect(classifyContextMenuTarget(a, 'notes/readme')).toBeNull();
  });
});
