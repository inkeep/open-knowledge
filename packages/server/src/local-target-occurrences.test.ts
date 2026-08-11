import { describe, expect, test } from 'vitest';
import {
  extractLocalTargetOccurrences,
  type LocalTargetOccurrence,
} from './local-target-occurrences.ts';

/**
 * Assert every occurrence's range reproduces authored bytes verbatim: the slice
 * opens with the form's own delimiter and contains its authored href (reference
 * uses take the href from the definition, so their bytes are exempt).
 */
function assertByteExact(source: string, occurrences: LocalTargetOccurrence[]): void {
  for (const occ of occurrences) {
    const slice = source.slice(occ.range.start, occ.range.end);
    expect(slice.length).toBeGreaterThan(0);
    if (occ.sourceForm !== 'markdown-reference') {
      expect(slice).toContain(occ.href);
    }
    switch (occ.sourceForm) {
      case 'markdown-inline':
      case 'markdown-reference':
        expect(slice.startsWith('[') || slice.startsWith('![')).toBe(true);
        break;
      case 'html-img':
        expect(slice.startsWith('<img')).toBe(true);
        break;
      case 'wiki-link':
        expect(slice.startsWith('[[')).toBe(true);
        break;
      case 'wiki-embed':
        expect(slice.startsWith('![[')).toBe(true);
        break;
    }
  }
}

describe('admitted inline forms', () => {
  test('inline markdown link', () => {
    const md = 'See [the doc](./guide.md) now.';
    const [occ, ...rest] = extractLocalTargetOccurrences(md);
    expect(rest).toEqual([]);
    expect(occ).toMatchObject({ role: 'link', sourceForm: 'markdown-inline', href: './guide.md' });
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('[the doc](./guide.md)');
    expect(occ?.line).toBe(0);
    expect(occ?.column).toBe(4);
  });

  test('inline markdown image', () => {
    const md = '![alt text](./diagram.png)';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ).toMatchObject({
      role: 'image',
      sourceForm: 'markdown-inline',
      href: './diagram.png',
    });
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('![alt text](./diagram.png)');
    expect(occ?.column).toBe(0);
  });

  test('angle-wrapped destination is unwrapped in href but the range covers the angles', () => {
    const md = '[doc](<./my file.md>)';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ?.href).toBe('./my file.md');
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('[doc](<./my file.md>)');
  });

  test('root-relative and parent-relative paths are admitted', () => {
    const md = '[a](/root/file.md) and [b](../sibling/file.md)';
    const occ = extractLocalTargetOccurrences(md);
    expect(occ.map((o) => o.href)).toEqual(['/root/file.md', '../sibling/file.md']);
  });

  test('a badge link emits both the outer link and nested image with exact ranges', () => {
    const md = '[![badge](./badge.png)](./target.md)';
    const occurrences = extractLocalTargetOccurrences(md);

    expect(occurrences.map(({ role, href }) => [role, href])).toEqual([
      ['link', './target.md'],
      ['image', './badge.png'],
    ]);
    expect(md.slice(occurrences[0]?.range.start, occurrences[0]?.range.end)).toBe(md);
    expect(md.slice(occurrences[1]?.range.start, occurrences[1]?.range.end)).toBe(
      '![badge](./badge.png)',
    );
  });
});

describe('admitted HTML img forms', () => {
  test('bare void HTML img', () => {
    const md = 'Before <img src="./photo.png"> after';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ).toMatchObject({ role: 'image', sourceForm: 'html-img', href: './photo.png' });
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('<img src="./photo.png">');
  });

  test('self-closing HTML img', () => {
    const md = '<img src="./photo.png" alt="p" />';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ).toMatchObject({ role: 'image', sourceForm: 'html-img', href: './photo.png' });
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('<img src="./photo.png" alt="p" />');
  });
});

describe('admitted wiki forms', () => {
  test('wiki link and wiki embed', () => {
    const md = 'A [[Some Page]] and an embed ![[photo.png]] here';
    const occ = extractLocalTargetOccurrences(md);
    expect(occ.map((o) => [o.role, o.sourceForm, o.href])).toEqual([
      ['link', 'wiki-link', 'Some Page'],
      ['image', 'wiki-embed', 'photo.png'],
    ]);
    expect(md.slice(occ[0]?.range.start, occ[0]?.range.end)).toBe('[[Some Page]]');
    expect(md.slice(occ[1]?.range.start, occ[1]?.range.end)).toBe('![[photo.png]]');
  });
});

describe('reference-style forms map every use to one definition', () => {
  test('full, collapsed, and shortcut uses resolve to the shared definition', () => {
    const md = [
      'Full [see one][doc].',
      'Collapsed [doc][].',
      'Shortcut [doc].',
      '',
      '[doc]: ./manual.pdf',
    ].join('\n');
    const occ = extractLocalTargetOccurrences(md);
    expect(occ.map((o) => o.reference?.kind)).toEqual(['full', 'collapsed', 'shortcut']);
    // Every use carries the same resolved href and the SAME definition object.
    expect(occ.every((o) => o.href === './manual.pdf')).toBe(true);
    const defs = new Set(occ.map((o) => o.reference?.definition));
    expect(defs.size).toBe(1);
  });

  test('the shared definition repair range bounds the destination token', () => {
    const md = '[a][doc]\n\n[doc]: ./manual.pdf';
    const [occ] = extractLocalTargetOccurrences(md);
    const repair = occ?.reference?.definition.repairRange;
    expect(md.slice(repair?.start, repair?.end)).toBe('./manual.pdf');
  });

  test('every authored use keeps its own occurrence range', () => {
    const md = '[first][doc] then [second][doc]\n\n[doc]: ./x.pdf';
    const occ = extractLocalTargetOccurrences(md);
    expect(md.slice(occ[0]?.range.start, occ[0]?.range.end)).toBe('[first][doc]');
    expect(md.slice(occ[1]?.range.start, occ[1]?.range.end)).toBe('[second][doc]');
    expect(occ[0]?.reference?.definition).toBe(occ[1]?.reference?.definition);
  });

  test('reference resolution is case-insensitive and whitespace-collapsed', () => {
    const md = '[link][My   Ref]\n\n[my ref]: ./target.md';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ?.href).toBe('./target.md');
    expect(occ?.reference?.label).toBe('my ref');
  });

  test('reference resolution applies CommonMark Unicode case folding', () => {
    const [occ] = extractLocalTargetOccurrences('[link][ẞ]\n\n[SS]: ./target.md');
    expect(occ?.href).toBe('./target.md');
  });

  test('reference-style image', () => {
    const md = '![alt][img]\n\n[img]: ./picture.png';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ).toMatchObject({
      role: 'image',
      sourceForm: 'markdown-reference',
      href: './picture.png',
    });
  });

  test('a reference use with no matching definition is not a link and is not emitted', () => {
    expect(extractLocalTargetOccurrences('[text][missing] and [alsoMissing].')).toEqual([]);
  });

  test('the definition line itself yields no occurrence', () => {
    // `[doc]` on the definition line must not be read as a shortcut use of itself.
    expect(extractLocalTargetOccurrences('[doc]: ./only-a-definition.pdf')).toEqual([]);
  });

  test('an external definition destination is not emitted as a local target', () => {
    expect(extractLocalTargetOccurrences('[x][ext]\n\n[ext]: https://example.com')).toEqual([]);
  });

  test('a destination continued onto the next line is recognized with an exact repair range', () => {
    const md = '[manual][ref]\n\n[ref]:\n      <./manual file.pdf>\n';
    const [occurrence] = extractLocalTargetOccurrences(md);

    expect(occurrence?.href).toBe('./manual file.pdf');
    expect(occurrence?.reference?.definition.line).toBe(2);
    const repairRange = occurrence?.reference?.definition.repairRange;
    expect(md.slice(repairRange?.start, repairRange?.end)).toBe('<./manual file.pdf>');
  });

  test('a title continued onto the next line remains part of one definition block', () => {
    const md = '[manual][ref]\n\n[ref]: ./manual.pdf\n  "Manual"\n';
    const occurrences = extractLocalTargetOccurrences(md);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.href).toBe('./manual.pdf');
  });
});

describe('context exclusions produce no false local targets', () => {
  test('frontmatter is excluded', () => {
    const md = ['---', 'cover: [x](./in-frontmatter.md)', '---', '[real](./body.md)'].join('\n');
    const occ = extractLocalTargetOccurrences(md);
    expect(occ.map((o) => o.href)).toEqual(['./body.md']);
  });

  test('fenced code blocks are excluded (backtick and tilde)', () => {
    const md = [
      '```',
      '[x](./in-backtick-fence.md)',
      '```',
      '~~~',
      '[y](./in-tilde-fence.md)',
      '~~~',
      '[real](./body.md)',
    ].join('\n');
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });

  test('inline code is excluded', () => {
    const md = 'Type `[x](./in-code.md)` but link [real](./body.md).';
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });

  test('a backslash-escaped opener is excluded', () => {
    const md = '\\[not a link](./escaped.md) but [real](./body.md)';
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });

  test('indented code is excluded', () => {
    const md = '    ![not rendered](./indented.png)\n\t[x](./tabbed.pdf)\n[real](./body.md)';
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });

  test('HTML comments are excluded across and within lines', () => {
    const md = [
      '<!-- ![inline](./inline.png) --> [real](./body.md)',
      '<!--',
      '[ref]: ./comment.pdf',
      '![block](./block.png)',
      '-->',
      '[ref]',
    ].join('\n');
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });

  test('an HTML opener inside inline code does not mask a trailing real link', () => {
    const md = '`<!--` [real](./body.md) and `<pre>` [also](./other.md)';
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual([
      './body.md',
      './other.md',
    ]);
  });

  test('raw pre and code regions are excluded, including inline regions', () => {
    const md = [
      '<pre>![pre](./pre.png)</pre> [real](./body.md)',
      '<code>',
      '[code](./code.pdf)',
      '</code>',
    ].join('\n');
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./body.md']);
  });
});

describe('href classification excludes non-local targets', () => {
  test('external URLs (any scheme, protocol-relative) are excluded', () => {
    const md = [
      '[a](https://example.com)',
      '[b](http://example.com/x)',
      '[c](mailto:me@example.com)',
      '[d](//cdn.example.com/x.png)',
      '<img src="https://example.com/x.png">',
      '[[https://example.com]]',
      '[keep](./local.md)',
    ].join('\n');
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./local.md']);
  });

  test('bare anchors are excluded', () => {
    const md = '[section](#heading) but [doc](./page.md#heading) is local';
    expect(extractLocalTargetOccurrences(md).map((o) => o.href)).toEqual(['./page.md#heading']);
  });

  test('a traversal-escaping path is still captured for downstream assessment, not silently dropped', () => {
    // Recognition makes no existence claim; it captures the authored path with an
    // exact range so the assessment layer can report it, rather than treating it
    // as a valid local file.
    const md = '[x](../../../../etc/passwd)';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ?.href).toBe('../../../../etc/passwd');
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('[x](../../../../etc/passwd)');
  });
});

describe('positions fold in frontmatter and CRLF exactly', () => {
  test('line numbers count frontmatter lines and ranges stay byte-exact', () => {
    const md = ['---', 'title: x', '---', '', 'Body [doc](./guide.md).'].join('\n');
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ?.line).toBe(4);
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('[doc](./guide.md)');
  });

  test('CRLF documents keep exact byte ranges', () => {
    const md = 'Line one\r\n![p](./photo.png)\r\nLine three';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(occ?.line).toBe(1);
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('![p](./photo.png)');
  });

  test('a CRLF frontmatter block offsets the body range correctly', () => {
    const md = '---\r\ntitle: x\r\n---\r\n[doc](./guide.md)';
    const [occ] = extractLocalTargetOccurrences(md);
    expect(md.slice(occ?.range.start, occ?.range.end)).toBe('[doc](./guide.md)');
  });
});

describe('mixed corpus byte-preservation invariant', () => {
  test('every emitted occurrence and repair range reproduces its authored bytes', () => {
    const md = [
      '---',
      'title: Mixed',
      '---',
      '# Heading',
      '',
      'An inline [link](./a.md) and image ![alt](./b.png).',
      'HTML <img src="./c.png"> and self-closing <img src="./d.png"/>.',
      'Wiki [[Some Doc]] and embed ![[e.png]].',
      'Reference [use][ref] and [ref][] and [ref] shortcut.',
      '',
      '[ref]: ./f.pdf "a title"',
      '',
      '```',
      '[ignored](./g.md)',
      '```',
    ].join('\n');
    const occurrences = extractLocalTargetOccurrences(md);
    // a.md, b.png, c.png, d.png, Some Doc, e.png, ref x3
    expect(occurrences).toHaveLength(9);
    assertByteExact(md, occurrences);
    for (const occ of occurrences) {
      if (occ.reference) {
        const { start, end } = occ.reference.definition.repairRange;
        expect(md.slice(start, end)).toBe('./f.pdf');
      }
    }
    // Fenced content never leaks in.
    expect(occurrences.some((o) => o.href.includes('g.md'))).toBe(false);
  });
});
