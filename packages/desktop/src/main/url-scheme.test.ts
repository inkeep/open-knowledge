import { describe, expect, test } from 'bun:test';
import { encodeShareUrl } from '@inkeep/open-knowledge-core';
import { parseOpenKnowledgeUrl, parseScreenUrl, parseShareUrl } from './url-scheme.ts';


describe('parseOpenKnowledgeUrl — valid inputs', () => {
  test('parses well-formed open/project/doc URL', () => {
    const result = parseOpenKnowledgeUrl('openknowledge://open?project=/abs/path&doc=foo.md');
    expect(result).toEqual({
      host: 'open',
      project: '/abs/path',
      doc: 'foo.md',
    });
  });

  test('url-decodes project + doc before validation', () => {
    const result = parseOpenKnowledgeUrl(
      'openknowledge://open?project=%2Fabs%2Fmy%20path&doc=foo%20bar.md',
    );
    expect(result).toEqual({
      host: 'open',
      project: '/abs/my path',
      doc: 'foo bar.md',
    });
  });

  test('accepts flat doc-name', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=a_b-c.md')).toMatchObject({
      doc: 'a_b-c.md',
    });
  });

  test('accepts nested doc-name (common MCP producer shape)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=docs%2Fa')).toMatchObject({
      doc: 'docs/a',
    });
  });

  test('accepts deeply nested doc-name', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=deep%2Fnested%2Fpath%2Fhere.md'),
    ).toMatchObject({ doc: 'deep/nested/path/here.md' });
  });

  test('accepts unicode in nested doc-name', () => {
    expect(
      parseOpenKnowledgeUrl(
        'openknowledge://open?project=/abs&doc=notes%2F%E6%97%A5%E6%9C%AC%E8%AA%9E',
      ),
    ).toMatchObject({ doc: 'notes/日本語' });
  });
});

describe('parseOpenKnowledgeUrl — protocol + host validation', () => {
  test('rejects non-openknowledge protocol', () => {
    expect(parseOpenKnowledgeUrl('https://open?project=/abs/path&doc=foo.md')).toBeNull();
  });

  test('rejects unknown host (host !== "open")', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://delete?project=/abs/path&doc=foo.md')).toBeNull();
  });

  test('rejects empty host', () => {
    expect(parseOpenKnowledgeUrl('openknowledge:?project=/abs&doc=x')).toBeNull();
  });

  test('rejects obviously malformed URL', () => {
    expect(parseOpenKnowledgeUrl('not a url')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(parseOpenKnowledgeUrl('')).toBeNull();
  });
});

describe('parseOpenKnowledgeUrl — required params', () => {
  test('rejects missing project', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?doc=foo.md')).toBeNull();
  });

  test('rejects missing doc', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs/path')).toBeNull();
  });

  test('rejects empty project', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=&doc=foo.md')).toBeNull();
  });

  test('rejects empty doc', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=')).toBeNull();
  });
});

describe('parseOpenKnowledgeUrl — null-byte defense', () => {
  test('rejects literal null byte in raw input', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs\x00&doc=x.md')).toBeNull();
  });

  test('rejects %00 in project', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=%00/safe/proj&doc=x.md')).toBeNull();
  });

  test('rejects %00 in doc', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=x%00.md')).toBeNull();
  });

  test('rejects double-encoded %2500 in project (layered null-byte smuggle)', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=%2500/safe/proj&doc=x.md'),
    ).toBeNull();
  });

  test('rejects double-encoded %2500 in doc (layered null-byte smuggle)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=x%2500.md')).toBeNull();
  });
});

describe('parseOpenKnowledgeUrl — path-traversal defense', () => {
  test('rejects literal ../ in project', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=/abs/../etc/passwd&doc=x.md'),
    ).toBeNull();
  });

  test('rejects ../../ in project', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=../../etc/passwd&doc=x.md'),
    ).toBeNull();
  });

  test('rejects URL-encoded %2e%2e path traversal', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=%2e%2e%2f%2e%2e%2fetc%2fpasswd&doc=x.md'),
    ).toBeNull();
  });

  test('rejects relative project path', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=relative/path&doc=x.md')).toBeNull();
  });

  test('rejects ".." as literal doc', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=..')).toBeNull();
  });

  test('rejects ".." segment inside nested doc (`a/../b`)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=a%2F..%2Fb')).toBeNull();
  });

  test('rejects ".." at start of nested doc (`../foo`)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=..%2Ffoo.md')).toBeNull();
  });

  test('rejects ".." at end of nested doc (`foo/..`)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=foo%2F..')).toBeNull();
  });

  test('rejects leading slash in doc (absolute-path shape)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=%2Ffoo.md')).toBeNull();
  });

  test('rejects backslash in doc (Windows-style separator)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=sub\\foo.md')).toBeNull();
  });

  test('rejects URL-encoded backslash in nested doc', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=a%5Cb')).toBeNull();
  });

  test('rejects URL-encoded ../ prefix in doc', () => {
    expect(
      parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=%2e%2e%2ffoo.md'),
    ).toBeNull();
  });
});

describe('parseOpenKnowledgeUrl — MCP producer/consumer round-trip', () => {
  function buildProducerUrl(project: string, docName: string): string {
    return `openknowledge://open?project=${encodeURIComponent(project)}&doc=${encodeURIComponent(docName)}`;
  }

  test.each([
    'README',
    'notes/meeting',
    'docs/a',
    'deeply/nested/path/here.md',
    'with spaces/in name',
    'unicode/日本語',
    'punct/foo - bar',
  ])('round-trips producer docName: %s', (docName: string) => {
    const url = buildProducerUrl('/abs/project', docName);
    const parsed = parseOpenKnowledgeUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed?.doc).toBe(docName);
    expect(parsed?.project).toBe('/abs/project');
  });

  test('producer-shape traversal attempts still rejected', () => {
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', 'a/../b'))).toBeNull();
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', '../escape'))).toBeNull();
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', '/absolute'))).toBeNull();
  });
});

describe('parseShareUrl — universal-link happy path', () => {
  test('parses universal-link URL with main branch', () => {
    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/blob/main/marketing.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toEqual({
      kind: 'ok',
      source: 'universal-link',
      payload: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        sharedUrl: 'https://github.com/inkeep/playbooks/blob/main/marketing.md',
        target: { kind: 'doc', docPath: 'marketing.md' },
      },
    });
  });

  test('parses universal-link with www. subdomain (AASA dual-host parity)', () => {
    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/blob/main/x.md');
    const result = parseShareUrl(`https://www.openknowledge.ai/d/${encoded}`);
    expect(result?.kind).toBe('ok');
    expect(result?.source).toBe('universal-link');
  });

  test('parses universal-link with branch containing percent-encoded slash', () => {
    const encoded = encodeShareUrl('https://github.com/o/r/blob/feat%2Ffoo/docs/sub/page.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toMatchObject({
      kind: 'ok',
      payload: { branch: 'feat/foo', target: { kind: 'doc', docPath: 'docs/sub/page.md' } },
    });
  });

  test('parses universal-link with unicode + spaces in path (per-segment encoded)', () => {
    const sharedUrl =
      'https://github.com/inkeep/playbooks/blob/main/docs/Q4%20OKRs%20%E2%80%94%20Marketing.md';
    const encoded = encodeShareUrl(sharedUrl);
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toMatchObject({
      kind: 'ok',
      payload: { target: { kind: 'doc', docPath: 'docs/Q4 OKRs — Marketing.md' } },
    });
  });
});

describe('parseShareUrl — universal-link extensibility (D30 Axis 1+2)', () => {
  test('tolerates unknown query parameters', () => {
    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    const result = parseShareUrl(
      `https://openknowledge.ai/d/${encoded}?utm_source=slack&ref=campaign`,
    );
    expect(result?.kind).toBe('ok');
  });

  test('tolerates a URL fragment', () => {
    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}#section-2`);
    expect(result?.kind).toBe('ok');
  });

  test('tolerates query + fragment together', () => {
    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    const result = parseShareUrl(
      `https://openknowledge.ai/d/${encoded}?utm_source=slack#section-2`,
    );
    expect(result?.kind).toBe('ok');
  });
});

describe('parseShareUrl — universal-link error states', () => {
  test('reports unsupported-version for v2 payload (0x02 byte)', () => {
    const blobBytes = new TextEncoder().encode('https://github.com/o/r/blob/main/x.md');
    const payload = new Uint8Array(blobBytes.length + 1);
    payload[0] = 0x02;
    payload.set(blobBytes, 1);
    let b64 = '';
    for (const byte of payload) b64 += String.fromCharCode(byte);
    const encoded = btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toEqual({
      kind: 'unsupported-version',
      source: 'universal-link',
      version: 2,
    });
  });

  test('reports invalid for corrupt base64url body', () => {
    const result = parseShareUrl('https://openknowledge.ai/d/!!!not-base64!!!');
    expect(result).toEqual({ kind: 'invalid', source: 'universal-link' });
  });

  test('reports invalid for empty encoded body', () => {
    const result = parseShareUrl('https://openknowledge.ai/d/');
    expect(result).toEqual({ kind: 'invalid', source: 'universal-link' });
  });

  test('reports invalid for non-github blob URL inside the payload', () => {
    const encoded = encodeShareUrl('https://gitlab.com/o/r/-/blob/main/x.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toEqual({ kind: 'invalid', source: 'universal-link' });
  });

  test('parses a github /tree/ URL as a folder target', () => {
    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/tree/main/docs');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toMatchObject({
      kind: 'ok',
      source: 'universal-link',
      payload: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        target: { kind: 'folder', folderPath: 'docs' },
      },
    });
  });

  test('reports invalid for extra path segments after /d/<encoded>', () => {
    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}/extra`);
    expect(result).toEqual({ kind: 'invalid', source: 'universal-link' });
  });
});

describe('parseShareUrl — custom-scheme happy path', () => {
  test('parses openknowledge://share?url=<blob-url>', () => {
    const sharedUrl = 'https://github.com/inkeep/playbooks/blob/main/marketing.md';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toEqual({
      kind: 'ok',
      source: 'custom-scheme',
      payload: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        sharedUrl,
        target: { kind: 'doc', docPath: 'marketing.md' },
      },
    });
  });

  test('parses custom-scheme with percent-encoded slash in branch', () => {
    const sharedUrl = 'https://github.com/o/r/blob/feat%2Ffoo/docs/page.md';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toMatchObject({
      kind: 'ok',
      source: 'custom-scheme',
      payload: { branch: 'feat/foo', target: { kind: 'doc', docPath: 'docs/page.md' } },
    });
  });

  test('tolerates additional query params on custom-scheme path', () => {
    const sharedUrl = 'https://github.com/o/r/blob/main/x.md';
    const result = parseShareUrl(
      `openknowledge://share?url=${encodeURIComponent(sharedUrl)}&ref=campaign`,
    );
    expect(result?.kind).toBe('ok');
    expect(result?.source).toBe('custom-scheme');
  });
});

describe('parseShareUrl — custom-scheme error states', () => {
  test('reports invalid when url param is missing', () => {
    const result = parseShareUrl('openknowledge://share');
    expect(result).toEqual({ kind: 'invalid', source: 'custom-scheme' });
  });

  test('reports invalid when url param is empty', () => {
    const result = parseShareUrl('openknowledge://share?url=');
    expect(result).toEqual({ kind: 'invalid', source: 'custom-scheme' });
  });

  test('reports invalid for non-github URL', () => {
    const sharedUrl = 'https://gitlab.com/o/r/-/blob/main/x.md';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toEqual({ kind: 'invalid', source: 'custom-scheme' });
  });

  test('reports invalid for github URL that is neither a blob nor a tree URL', () => {
    const sharedUrl = 'https://github.com/o/r/pull/123';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toEqual({ kind: 'invalid', source: 'custom-scheme' });
  });

  test('parses a github /tree/ URL as a folder target (custom-scheme)', () => {
    const sharedUrl = 'https://github.com/o/r/tree/main/docs';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toMatchObject({
      kind: 'ok',
      source: 'custom-scheme',
      payload: {
        owner: 'o',
        repo: 'r',
        branch: 'main',
        target: { kind: 'folder', folderPath: 'docs' },
      },
    });
  });

  test('parses a github /tree/ root URL as a folder target with empty folderPath', () => {
    const sharedUrl = 'https://github.com/o/r/tree/main';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toMatchObject({
      kind: 'ok',
      source: 'custom-scheme',
      payload: {
        owner: 'o',
        repo: 'r',
        branch: 'main',
        target: { kind: 'folder', folderPath: '' },
      },
    });
  });
});

describe('parseShareUrl — not-a-share-url (returns null, caller falls through)', () => {
  test('returns null for openknowledge://open?... (legacy open action)', () => {
    const result = parseShareUrl('openknowledge://open?project=/abs&doc=x.md');
    expect(result).toBeNull();
  });

  test('returns null for openknowledge:// with unknown host (host !== share|open)', () => {
    expect(parseShareUrl('openknowledge://delete?url=x')).toBeNull();
  });

  test('returns null for plain HTTPS URL not on openknowledge.ai', () => {
    const result = parseShareUrl('https://example.com/d/abc');
    expect(result).toBeNull();
  });

  test('returns null for openknowledge.ai URL not under /d/', () => {
    expect(parseShareUrl('https://openknowledge.ai/docs/getting-started')).toBeNull();
    expect(parseShareUrl('https://openknowledge.ai/')).toBeNull();
    expect(parseShareUrl('https://openknowledge.ai')).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(parseShareUrl('')).toBeNull();
  });

  test('returns null for malformed URL', () => {
    expect(parseShareUrl('not a url')).toBeNull();
  });

  test('returns null for null-byte smuggle attempts', () => {
    expect(parseShareUrl('https://openknowledge.ai/d/abc\x00')).toBeNull();
    expect(parseShareUrl('https://openknowledge.ai/d/abc%00def')).toBeNull();
  });
});

describe('parseScreenUrl', () => {
  test('parses the settings screen', () => {
    expect(parseScreenUrl('openknowledge://screen?name=settings')).toEqual({
      host: 'screen',
      name: 'settings',
    });
  });

  test('parses the install-claude screen', () => {
    expect(parseScreenUrl('openknowledge://screen?name=install-claude')).toEqual({
      host: 'screen',
      name: 'install-claude',
    });
  });

  test('URL-decodes the name param', () => {
    expect(parseScreenUrl('openknowledge://screen?name=install%2Dclaude')).toEqual({
      host: 'screen',
      name: 'install-claude',
    });
  });

  test('returns null for an unknown screen name', () => {
    expect(parseScreenUrl('openknowledge://screen?name=admin')).toBeNull();
    expect(parseScreenUrl('openknowledge://screen?name=')).toBeNull();
  });

  test('returns null when the name param is missing', () => {
    expect(parseScreenUrl('openknowledge://screen')).toBeNull();
  });

  test('returns null for the wrong host', () => {
    expect(parseScreenUrl('openknowledge://open?name=settings')).toBeNull();
    expect(parseScreenUrl('openknowledge://share?name=settings')).toBeNull();
  });

  test('returns null for the wrong protocol', () => {
    expect(parseScreenUrl('https://screen?name=settings')).toBeNull();
  });

  test('returns null for malformed / empty input', () => {
    expect(parseScreenUrl('not a url')).toBeNull();
    expect(parseScreenUrl('')).toBeNull();
  });

  test('returns null for null-byte smuggle attempts', () => {
    expect(parseScreenUrl('openknowledge://screen?name=sett\x00ings')).toBeNull();
    expect(parseScreenUrl('openknowledge://screen?name=settings%00')).toBeNull();
    expect(parseScreenUrl('openknowledge://screen?name=settings%2500')).toBeNull();
  });
});
