import { describe, expect, test } from 'bun:test';

import {
  composeNewItemPath,
  ensureMdExtension,
  isNewItemShortcut,
  validatePath,
} from './NewItemDialog';
import { sortTemplatesForPicker } from './template-picker-utils';

describe('validatePath', () => {
  test('rejects empty / whitespace-only', () => {
    expect(validatePath('')).toBe('empty');
    expect(validatePath('   ')).toBe('empty');
  });

  test('rejects "..', () => {
    expect(validatePath('foo/../bar.md')).toBe('dotdot');
    expect(validatePath('..')).toBe('dotdot');
  });

  test('rejects leading /', () => {
    expect(validatePath('/abs.md')).toBe('leading-slash');
  });

  test('rejects backslashes', () => {
    expect(validatePath('a\\b.md')).toBe('backslash');
  });

  test('rejects null bytes', () => {
    expect(validatePath('a\0b.md')).toBe('null-byte');
  });

  test('accepts regular names', () => {
    expect(validatePath('notes.md')).toBeNull();
    expect(validatePath('docs/nested.md')).toBeNull();
    expect(validatePath('my-page')).toBeNull();
  });
});

describe('ensureMdExtension', () => {
  test('appends .md when missing', () => {
    expect(ensureMdExtension('foo')).toBe('foo.md');
  });
  test('leaves .md in place', () => {
    expect(ensureMdExtension('foo.md')).toBe('foo.md');
  });
  test('leaves .mdx in place (first-class admission)', () => {
    expect(ensureMdExtension('foo.mdx')).toBe('foo.mdx');
  });
  test('does not double-append', () => {
    expect(ensureMdExtension('foo.md')).toBe('foo.md');
  });
  test('preserves an already-qualified extension like .md.md', () => {
    expect(ensureMdExtension('foo.md.md')).toBe('foo.md.md');
  });
});

describe('composeNewItemPath — kind=file', () => {
  test('root: fileName only', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: '', fileName: 'note.md' })).toBe(
      'note.md',
    );
  });

  test('root: auto-appends .md', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: '', fileName: 'my-note' })).toBe(
      'my-note.md',
    );
  });

  test('subdir: joins with slash', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: 'docs', fileName: 'guide.md' })).toBe(
      'docs/guide.md',
    );
  });

  test('trims fileName whitespace', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: 'docs', fileName: '  guide  ' })).toBe(
      'docs/guide.md',
    );
  });

  test('nested dir', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: 'a/b/c', fileName: 'leaf.md' })).toBe(
      'a/b/c/leaf.md',
    );
  });

  test('explicit .mdx via fileExtension state produces a .mdx path', () => {
    expect(
      composeNewItemPath({
        kind: 'file',
        initialDir: '',
        fileName: 'component',
        fileExtension: '.mdx',
      }),
    ).toBe('component.mdx');
  });

  test('typed-in extension wins over fileExtension state (Finder-like)', () => {
    expect(
      composeNewItemPath({
        kind: 'file',
        initialDir: '',
        fileName: 'foo.mdx',
        fileExtension: '.md',
      }),
    ).toBe('foo.mdx');
  });

  test('fileExtension defaults to .md when omitted (backward-compat)', () => {
    expect(composeNewItemPath({ kind: 'file', initialDir: '', fileName: 'bare' })).toBe('bare.md');
  });
});

describe('composeNewItemPath — kind=folder (composite)', () => {
  test('root: folder + first file', () => {
    expect(
      composeNewItemPath({
        kind: 'folder',
        initialDir: '',
        folderName: 'proj',
        fileName: 'index.md',
      }),
    ).toBe('proj/index.md');
  });

  test('nested: dir + folder + first file', () => {
    expect(
      composeNewItemPath({
        kind: 'folder',
        initialDir: 'docs',
        folderName: 'guides',
        fileName: 'index.md',
      }),
    ).toBe('docs/guides/index.md');
  });

  test('auto .md on first file', () => {
    expect(
      composeNewItemPath({
        kind: 'folder',
        initialDir: 'docs',
        folderName: 'guides',
        fileName: 'home',
      }),
    ).toBe('docs/guides/home.md');
  });

  test('trims folder and file names', () => {
    expect(
      composeNewItemPath({
        kind: 'folder',
        initialDir: 'docs',
        folderName: '  guides  ',
        fileName: '  home  ',
      }),
    ).toBe('docs/guides/home.md');
  });
});

describe('isNewItemShortcut', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, key: 'n' };

  test('Cmd+N on BODY matches', () => {
    expect(
      isNewItemShortcut(
        {
          ...base,
          metaKey: true,
          target: { tagName: 'BODY' },
        },
        'mac',
      ),
    ).toBe(true);
  });

  test('Ctrl+N on BODY matches on Windows/Linux', () => {
    expect(
      isNewItemShortcut(
        {
          ...base,
          ctrlKey: true,
          target: { tagName: 'BODY' },
        },
        'windowsLinux',
      ),
    ).toBe(true);
  });

  test('Ctrl+Alt+N browser fallback still matches', () => {
    expect(
      isNewItemShortcut({
        ...base,
        ctrlKey: true,
        altKey: true,
        target: { tagName: 'DIV' },
      }),
    ).toBe(true);
  });

  test('Cmd+Alt+N browser fallback still matches', () => {
    expect(
      isNewItemShortcut({
        ...base,
        metaKey: true,
        altKey: true,
        target: { tagName: 'BODY' },
      }),
    ).toBe(true);
  });

  test('uppercase key value still matches when Shift is not held', () => {
    expect(
      isNewItemShortcut(
        {
          ...base,
          metaKey: true,
          key: 'N',
          target: { tagName: 'BODY' },
        },
        'mac',
      ),
    ).toBe(true);
  });

  test('does not match Cmd+Shift+N because New Folder owns that shortcut', () => {
    expect(
      isNewItemShortcut(
        {
          ...base,
          metaKey: true,
          shiftKey: true,
          key: 'N',
          target: { tagName: 'BODY' },
        },
        'mac',
      ),
    ).toBe(false);
  });

  test('blocked when target is INPUT', () => {
    expect(
      isNewItemShortcut({
        ...base,
        metaKey: true,
        target: { tagName: 'INPUT' },
      }),
    ).toBe(false);
  });

  test('blocked when target is TEXTAREA', () => {
    expect(
      isNewItemShortcut({
        ...base,
        ctrlKey: true,
        target: { tagName: 'TEXTAREA' },
      }),
    ).toBe(false);
  });

  test('blocked when target is contenteditable', () => {
    expect(
      isNewItemShortcut({
        ...base,
        metaKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      }),
    ).toBe(false);
  });

  test('does not match without Cmd/Ctrl', () => {
    expect(
      isNewItemShortcut({
        ...base,
        altKey: true,
        key: 'n',
        target: { tagName: 'BODY' },
      }),
    ).toBe(false);
  });

  test('does not match other keys', () => {
    expect(
      isNewItemShortcut({
        ...base,
        metaKey: true,
        altKey: true,
        key: 'm',
        target: { tagName: 'BODY' },
      }),
    ).toBe(false);
  });

  test('tolerates null target', () => {
    expect(
      isNewItemShortcut({
        ...base,
        metaKey: true,
        altKey: true,
        target: null,
      }),
    ).toBe(true);
  });
});

describe('sortTemplatesForPicker', () => {
  function entry(
    name: string,
    scope: 'local' | 'inherited',
    title?: string,
  ): {
    name: string;
    title?: string;
    description?: string;
    path: string;
    source_folder: string;
    scope: 'local' | 'inherited';
  } {
    return {
      name,
      ...(title === undefined ? {} : { title }),
      path: `${name}.md`,
      source_folder: '',
      scope,
    };
  }

  test('groups by scope: local → inherited', () => {
    const sorted = sortTemplatesForPicker([
      entry('beta-inherited', 'inherited'),
      entry('alpha-local', 'local'),
    ]);
    expect(sorted.map((t) => t.name)).toEqual(['alpha-local', 'beta-inherited']);
  });

  test('within scope, sorts by title (or name when title absent)', () => {
    const sorted = sortTemplatesForPicker([
      entry('zoo', 'local', 'Aardvark'),
      entry('apple', 'local'),
      entry('banana', 'local', 'Cherry'),
    ]);
    expect(sorted.map((t) => t.name)).toEqual(['zoo', 'apple', 'banana']);
  });

  test('returns a new array (does not mutate input)', () => {
    const input = [entry('b', 'local'), entry('a', 'local')];
    const sorted = sortTemplatesForPicker(input);
    expect(sorted).not.toBe(input);
    expect(input.map((t) => t.name)).toEqual(['b', 'a']);
  });

  test('handles empty list', () => {
    expect(sortTemplatesForPicker([])).toEqual([]);
  });

  test('mixed scopes interleaved are correctly grouped', () => {
    const sorted = sortTemplatesForPicker([
      entry('m-local', 'local'),
      entry('a-inherited', 'inherited'),
      entry('c-local', 'local'),
    ]);
    expect(sorted.map((t) => `${t.scope}:${t.name}`)).toEqual([
      'local:c-local',
      'local:m-local',
      'inherited:a-inherited',
    ]);
  });
});
