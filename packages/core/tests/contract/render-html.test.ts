import { describe, expect, test } from 'bun:test';
import { markdownToHtml, mdastToHtml } from '../../src/index.ts';

describe('markdownToHtml — documented construct render contract', () => {
  test('ATX heading renders to its level element (no paragraph wrap)', () => {
    expect(markdownToHtml('## Heading')).toBe('<h2>Heading</h2>');
  });

  test('heading levels h1 through h6', () => {
    const html = markdownToHtml('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    expect(html).toContain('<h1>a</h1>');
    expect(html).toContain('<h2>b</h2>');
    expect(html).toContain('<h3>c</h3>');
    expect(html).toContain('<h4>d</h4>');
    expect(html).toContain('<h5>e</h5>');
    expect(html).toContain('<h6>f</h6>');
  });

  test('strong and emphasis render to <strong> / <em>', () => {
    expect(markdownToHtml('**bold** and *italic*')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    );
  });

  test('inline code renders to <code>', () => {
    expect(markdownToHtml('run `npm install`')).toBe('<p>run <code>npm install</code></p>');
  });

  test('unordered list renders to <ul><li>', () => {
    const html = markdownToHtml('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  test('ordered list renders to <ol><li>', () => {
    const html = markdownToHtml('1. one\n2. two');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>one</li>');
  });

  test('link renders to <a href>', () => {
    expect(markdownToHtml('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com">site</a></p>',
    );
  });

  test('blockquote renders to <blockquote><p>', () => {
    const html = markdownToHtml('> quoted');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<p>quoted</p>');
  });

  test('fenced code block carries the language- class', () => {
    const html = markdownToHtml('```typescript\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-typescript">');
    expect(html).toContain('const x = 1;');
  });
});

describe('markdownToHtml — outbound URL-scheme sanitization', () => {
  test('javascript: href is stripped; the link element and text survive', () => {
    const html = markdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toBe('<p><a>click</a></p>');
  });

  test('data: href is stripped', () => {
    const html = markdownToHtml('[boom](data:text/html,xx)');
    expect(html).not.toContain('data:');
    expect(html).toBe('<p><a>boom</a></p>');
  });

  test('vbscript: href is stripped', () => {
    const html = markdownToHtml('[c](vbscript:msgbox)');
    expect(html).not.toContain('vbscript:');
    expect(html).toBe('<p><a>c</a></p>');
  });

  test('file: href is stripped', () => {
    const html = markdownToHtml('[open](file:///etc/passwd)');
    expect(html).not.toContain('file:');
    expect(html).toBe('<p><a>open</a></p>');
  });

  test('dangerous scheme is stripped from an image src; the <img> and alt survive', () => {
    const html = markdownToHtml('![alt](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toBe('<p><img alt="alt"></p>');
  });

  test('scheme matching is case-insensitive', () => {
    expect(markdownToHtml('[a](JavaScript:alert(1))')).not.toMatch(/javascript:/i);
    expect(markdownToHtml('[b](DATA:text/html,x)')).not.toMatch(/data:/i);
  });

  test('the full scheme allowlist (https, http, mailto, tel, ftp, sms) and relative/anchor hrefs survive', () => {
    expect(markdownToHtml('[a](https://example.com)')).toContain('href="https://example.com"');
    expect(markdownToHtml('[b](http://example.com)')).toContain('href="http://example.com"');
    expect(markdownToHtml('[c](mailto:foo@example.com)')).toContain(
      'href="mailto:foo@example.com"',
    );
    expect(markdownToHtml('[d](tel:+15551234)')).toContain('href="tel:+15551234"');
    expect(markdownToHtml('[e](ftp://files.example.com)')).toContain(
      'href="ftp://files.example.com"',
    );
    expect(markdownToHtml('[f](sms:+15551234)')).toContain('href="sms:+15551234"');
    expect(markdownToHtml('[g](/relative/path)')).toContain('href="/relative/path"');
    expect(markdownToHtml('[h](#section)')).toContain('href="#section"');
  });

  test('allowlist closure: an unlisted scheme is rejected, not just the named dangerous ones', () => {
    expect(markdownToHtml('[a](blob:https://x)')).toBe('<p><a>a</a></p>');
    expect(markdownToHtml('[b](intent://scan/#Intent;end)')).toBe('<p><a>b</a></p>');
    expect(markdownToHtml('[c](view-source:http://x)')).toBe('<p><a>c</a></p>');
  });

  test('entity-obfuscated scheme is decoded before sanitizing, then dropped', () => {
    const html = markdownToHtml('[x](java&#x73;cript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toBe('<p><a>x</a></p>');
  });

  test('leading whitespace before a dangerous scheme does not smuggle it through', () => {
    const html = markdownToHtml('[x]( javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toBe('<p><a>x</a></p>');
  });
});

describe('mdastToHtml — tree-entry render contract', () => {
  test('a paragraph mdast tree renders to <p>', () => {
    const html = mdastToHtml({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }],
    });
    expect(html).toBe('<p>hi</p>');
  });
});
