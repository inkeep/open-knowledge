import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  assetReferenceSignature,
  assetReferencesChanged,
  collectReferencedAssets,
  extractLocalAssetHrefs,
  isRemoteOrOpaqueHref,
  resolveReferencedAssetPath,
  stripHrefDecorations,
} from './asset-references.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { getLogger } from './logger.ts';

function withFixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-assets-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('asset reference extraction', () => {
  test('extracts markdown image, markdown link, wiki link, and HTML link hrefs', () => {
    expect(
      extractLocalAssetHrefs(
        [
          '![Alt](./a.png)',
          '[Photo](./b.jpg)',
          '[PDF](./paper.pdf)',
          '![Spaced](<./my photo.png>)',
          '![[wiki.png]]',
          '[[linked-wiki.jpg]]',
          '[[linked-wiki.pdf]]',
          '<a href="./download.csv">Download</a>',
          '<a href=./unquoted.pdf>Unquoted</a>',
          '<a href=“./smart.pdf”>Smart</a>',
          "<a href='./single-quoted.pdf'>Single</a>",
          '<a data-href="./ignored.pdf">Ignored</a>',
          '<img src="./c.jpeg" />',
          '<img data-src="./placeholder.png" src="./real.png" />',
          '<image src="./d.png" />',
        ].join('\n'),
      ),
    ).toEqual([
      './a.png',
      './b.jpg',
      './paper.pdf',
      './my photo.png',
      'wiki.png',
      'linked-wiki.jpg',
      'linked-wiki.pdf',
      './download.csv',
      './unquoted.pdf',
      './smart.pdf',
      './single-quoted.pdf',
      './c.jpeg',
      './real.png',
      './d.png',
    ]);
  });

  test('ignores asset-looking references in fenced code, inline code, and comments', () => {
    expect(
      extractLocalAssetHrefs(
        [
          '![Real](./real.png)',
          '',
          '```md',
          '![Example](./code.png)',
          '![[code-wiki.jpg]]',
          '```',
          'Inline `![Code](./inline.png)` text',
          '<!-- ![Comment](./comment.png) -->',
          '<!--',
          '<img src="./comment-block.jpeg" />',
          '-->',
          '<img src="./real-html.jpeg" />',
        ].join('\n'),
      ),
    ).toEqual(['./real.png', './real-html.jpeg']);
  });

  const admits = (markdown: string): boolean => assetReferenceSignature(markdown) !== '';

  test('classifies only local supported asset hrefs as sidebar asset references', () => {
    expect(admits('[x](#section)')).toBe(false);
    expect(admits('[x](//cdn.example.com/photo.png)')).toBe(false);
    expect(admits('[x](https://example.com/photo.png)')).toBe(false);
    expect(admits('[x](data:image/png;base64,abc)')).toBe(false);
    expect(admits('[x](./local/photo.png)')).toBe(true);
    expect(admits('[x](<./local/photo.png?size=1#hero>)')).toBe(true);
    expect(admits('[x](./doc.md)')).toBe(false);
  });

  test('classifies .base and .canvas hrefs as local asset references', () => {
    expect(admits('[x](./Characters.base)')).toBe(true);
    expect(admits('[x](Characters.base)')).toBe(true);
    expect(admits('[x](./vault/Board.canvas)')).toBe(true);
  });

  test('resolves .base and .canvas hrefs to disk paths', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'vault'));
      writeFileSync(join(dir, 'vault', 'Characters.base'), 'fields:\n  - name\n');
      writeFileSync(join(dir, 'vault', 'Board.canvas'), '{"nodes":[],"edges":[]}\n');

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'vault/note',
          href: './Characters.base',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'vault/Characters.base')));

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'vault/note',
          href: './Board.canvas',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'vault/Board.canvas')));

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'vault/note',
          href: 'Board.canvas',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'vault/Board.canvas')));
    }));

  test('classifies remote or opaque hrefs', () => {
    expect(isRemoteOrOpaqueHref('#section')).toBe(true);
    expect(isRemoteOrOpaqueHref('//cdn.example.com/photo.png')).toBe(true);
    expect(isRemoteOrOpaqueHref('https://example.com/photo.png')).toBe(true);
    expect(isRemoteOrOpaqueHref('data:image/png;base64,abc')).toBe(true);
    expect(isRemoteOrOpaqueHref('./local/photo.png')).toBe(false);
  });

  test('strips angle brackets, hashes, and queries from hrefs', () => {
    expect(stripHrefDecorations('<./local/photo.png?size=1#hero>')).toBe('./local/photo.png');
    expect(stripHrefDecorations('./local/photo.png#hero')).toBe('./local/photo.png');
    expect(stripHrefDecorations('./local/photo.png?size=1')).toBe('./local/photo.png');
  });

  test('asset reference signature ignores remote and non-asset hrefs', () => {
    expect(
      assetReferenceSignature(
        [
          '[Fragment](#section)',
          '![Protocol](//cdn.example.com/photo.png)',
          '![Remote](https://example.com/photo.png)',
          '![Data](data:image/png;base64,abc)',
          '[Doc](./doc.md)',
          '',
        ].join('\n'),
      ),
    ).toBe('');
  });

  test('asset reference signature stays stable when prose changes but assets do not', () => {
    const before = [
      'Intro',
      '',
      '![Photo](./local/photo.png)',
      '![Again](./local/photo.png)',
      '',
    ].join('\n');
    const after = [
      'Edited intro',
      '',
      '![Photo](./local/photo.png)',
      'More prose',
      '![Again](./local/photo.png)',
      '',
    ].join('\n');

    expect(assetReferenceSignature(after)).toBe(assetReferenceSignature(before));
    expect(assetReferencesChanged(before, after)).toBe(false);
  });

  test('asset reference signature changes when local asset references change', () => {
    expect(assetReferenceSignature('![Photo](./local/photo.png)\n')).not.toBe(
      assetReferenceSignature('![Hero](./local/hero.png)\n'),
    );
    expect(
      assetReferencesChanged('![Photo](./local/photo.png)\n', '![Hero](./local/hero.png)\n'),
    ).toBe(true);
  });

  test('signature notices a plane switch on identical href bytes', () => {
    expect(assetReferencesChanged('![[100%20done.png]]', '[x](100%20done.png)')).toBe(true);
  });

  test('signature notices an asset whose extension is escaped', () => {
    expect(assetReferencesChanged('no refs here', '[x](./photo%2Ejpg)')).toBe(true);
  });

  test('resolves only existing local assets inside contentDir', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'photo.png'), 'png');
      writeFileSync(join(dir, 'docs', 'paper.pdf'), 'pdf');
      writeFileSync(join(dir, 'docs', 'My Photo.png'), 'png');

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: './photo.png',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs/photo.png')));
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '/docs/photo.png',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs/photo.png')));
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '<./My%20Photo.png>',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs/My Photo.png')));
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: './paper.pdf',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs/paper.pdf')));

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: 'https://example.com/photo.png',
          literal: false,
        }),
      ).toBeNull();
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '../outside.png',
          literal: false,
        }),
      ).toBeNull();
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: './missing.png',
          literal: false,
        }),
      ).toBeNull();
    }));

  test('resolves a %2520 href to a filename containing literal %20 without double decoding', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'My%20Photo.png'), 'png');
      writeFileSync(join(dir, 'docs', 'My Photo.png'), 'png');

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '<./My%2520Photo.png>',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs', 'My%20Photo.png')));
    }));

  test('a wiki target names the literal filename, not its decoded neighbour', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', '100%20done.png'), 'png');
      writeFileSync(join(dir, 'docs', '100 done.png'), 'png');

      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '100%20done.png',
          literal: true,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs', '100%20done.png')));
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: '100%20done.png',
          literal: true,
        }),
      ).not.toBe(realpathSync(resolve(dir, 'docs', '100 done.png')));
      expect(
        resolveReferencedAssetPath({
          contentDir: dir,
          fromDocName: 'docs/guide',
          href: './100%20done.png',
          literal: false,
        }),
      ).toBe(realpathSync(resolve(dir, 'docs', '100 done.png')));
    }));

  test('the collector carries each reference plane from its authored syntax', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', '100%20done.png'), 'png');
      writeFileSync(join(dir, 'docs', '100 done.png'), 'png');
      writeFileSync(
        join(dir, 'docs', 'guide.md'),
        '![[100%20done.png]]\n\n![md](./100%20done.png)\n',
      );

      const assets = collectReferencedAssets({
        contentDir: dir,
        fileIndex: new Map<string, FileIndexEntry>([
          [
            'docs/guide',
            { canonicalPath: join(dir, 'docs', 'guide.md') } as unknown as FileIndexEntry,
          ],
        ]),
        readMarkdown: (path) =>
          path.endsWith('guide.md') ? '![[100%20done.png]]\n\n![md](./100%20done.png)\n' : null,
      });

      expect(assets.map((a) => a.path).sort()).toEqual([
        'docs/100 done.png',
        'docs/100%20done.png',
      ]);
    }));

  test('byte-identical hrefs on both planes are both collected', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', '100%20done.png'), 'png');
      writeFileSync(join(dir, 'docs', '100 done.png'), 'png');
      const md = '![[100%20done.png]]\n\n[md](100%20done.png)\n';
      writeFileSync(join(dir, 'docs', 'guide.md'), md);

      const assets = collectReferencedAssets({
        contentDir: dir,
        fileIndex: new Map<string, FileIndexEntry>([
          [
            'docs/guide',
            { canonicalPath: join(dir, 'docs', 'guide.md') } as unknown as FileIndexEntry,
          ],
        ]),
        readMarkdown: (path) => (path.endsWith('guide.md') ? md : null),
      });

      expect(assets.map((a) => a.path).sort()).toEqual([
        'docs/100 done.png',
        'docs/100%20done.png',
      ]);
    }));

  test('collects referenced assets with referencing docs and ignores unreferenced files', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'guide.md'), '![Photo](./photo.png)\n![[embed.jpg]]');
      writeFileSync(
        join(dir, 'docs', 'second.md'),
        '[same](./photo.png)\n[paper](./paper.pdf)\n<a href="./data.csv">Data</a>',
      );
      writeFileSync(join(dir, 'docs', 'photo.png'), 'png');
      writeFileSync(join(dir, 'docs', 'embed.jpg'), 'jpg');
      writeFileSync(join(dir, 'docs', 'paper.pdf'), 'pdf');
      writeFileSync(join(dir, 'docs', 'data.csv'), 'csv');
      writeFileSync(join(dir, 'docs', 'orphan.png'), 'png');
      const now = new Date().toISOString();
      const fileIndex = new Map<string, FileIndexEntry>([
        [
          'docs/guide',
          {
            size: 1,
            modified: now,
            canonicalPath: join(dir, 'docs/guide.md'),
            inode: 1,
            aliases: [],
          },
        ],
        [
          'docs/second',
          {
            size: 1,
            modified: now,
            canonicalPath: join(dir, 'docs/second.md'),
            inode: 2,
            aliases: [],
          },
        ],
      ]);

      const assets = collectReferencedAssets({
        contentDir: dir,
        fileIndex,
        readMarkdown: (path) =>
          path.endsWith('guide.md')
            ? '![Photo](./photo.png)\n![[embed.jpg]]'
            : '[same](./photo.png)\n[paper](./paper.pdf)\n<a href="./data.csv">Data</a>',
      });

      expect(assets).toHaveLength(4);
      expect(assets.find((asset) => asset.path === 'docs/photo.png')).toMatchObject({
        kind: 'asset',
        path: 'docs/photo.png',
        assetExt: '.png',
        mediaKind: 'image',
        referencedBy: ['docs/guide', 'docs/second'],
      });
      expect(assets.find((asset) => asset.path === 'docs/embed.jpg')).toMatchObject({
        kind: 'asset',
        path: 'docs/embed.jpg',
        assetExt: '.jpg',
        mediaKind: 'image',
        referencedBy: ['docs/guide'],
      });
      expect(assets.find((asset) => asset.path === 'docs/paper.pdf')).toMatchObject({
        kind: 'asset',
        path: 'docs/paper.pdf',
        assetExt: '.pdf',
        mediaKind: 'pdf',
        referencedBy: ['docs/second'],
      });
      expect(assets.find((asset) => asset.path === 'docs/data.csv')).toMatchObject({
        kind: 'asset',
        path: 'docs/data.csv',
        assetExt: '.csv',
        mediaKind: null,
        referencedBy: ['docs/second'],
      });
    }));

  test('collects referenced existing html / gpx / xml / 7z assets (PRD-6948)', () =>
    withFixture((dir) => {
      mkdirSync(join(dir, 'fishing-log'), { recursive: true });
      writeFileSync(
        join(dir, 'fishing-log', 'log.md'),
        [
          '[viewer](./trip-viewer.html)',
          '[track](./Morning_Activity.gpx)',
          '[data](./readings.xml)',
          '[archive](./bundle.7z)',
          '[photo](./photo.png)',
        ].join('\n'),
      );
      for (const f of [
        'trip-viewer.html',
        'Morning_Activity.gpx',
        'readings.xml',
        'bundle.7z',
        'photo.png',
      ]) {
        writeFileSync(join(dir, 'fishing-log', f), 'x');
      }
      const now = new Date().toISOString();
      const fileIndex = new Map<string, FileIndexEntry>([
        [
          'fishing-log/log',
          {
            size: 1,
            modified: now,
            canonicalPath: join(dir, 'fishing-log/log.md'),
            inode: 1,
            aliases: [],
          },
        ],
      ]);

      const assets = collectReferencedAssets({
        contentDir: dir,
        fileIndex,
        readMarkdown: () =>
          [
            '[viewer](./trip-viewer.html)',
            '[track](./Morning_Activity.gpx)',
            '[data](./readings.xml)',
            '[archive](./bundle.7z)',
            '[photo](./photo.png)',
          ].join('\n'),
      });
      const paths = assets.map((a) => a.path).sort();
      expect(paths).toEqual([
        'fishing-log/Morning_Activity.gpx',
        'fishing-log/bundle.7z',
        'fishing-log/photo.png',
        'fishing-log/readings.xml',
        'fishing-log/trip-viewer.html',
      ]);
    }));

  test('returns empty asset list when content directory cannot be resolved', () => {
    const warnSpy = vi.spyOn(getLogger('asset-references'), 'warn');
    try {
      const assets = collectReferencedAssets({
        contentDir: join(tmpdir(), 'ok-missing-content-dir'),
        fileIndex: new Map(),
        readMarkdown: () => '',
      });

      expect(assets).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('returns null when resolving from a missing content directory', () => {
    const warnSpy = vi.spyOn(getLogger('asset-references'), 'warn');
    try {
      expect(
        resolveReferencedAssetPath({
          contentDir: join(tmpdir(), 'ok-missing-content-dir'),
          fromDocName: 'docs/guide',
          href: './photo.png',
          literal: false,
        }),
      ).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
