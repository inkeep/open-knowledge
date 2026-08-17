import { encodeShareUrl } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import fixture from '../../../../test-support/fixtures/share-url-v1-v2.json';
import {
  frozenV1CustomSchemeOutcome,
  frozenV1DecodeShareToken,
} from '../../../../test-support/share/frozen-v1-share-reader.test-helper.ts';
import { parseOpenKnowledgeUrl, parseScreenUrl, parseShareUrl } from './url-scheme.ts';

/**
 * The old-app claim is asserted through the SHARED frozen reader, never a
 * local restatement of it. A second oracle spelled out here would model the
 * same shipped binary at a different fidelity, and the two would agree only
 * for whichever inputs the corpus happens to carry.
 */
describe('frozen pre-v2 reader compatibility oracle', () => {
  test.each(fixture.customSchemeCases)('$id keeps its documented old-app outcome', (entry) => {
    expect(frozenV1CustomSchemeOutcome(entry.uri)).toBe(entry.baseline);
  });

  test.each(
    fixture.validShares.filter((entry) => entry.version === 2),
  )('$id remains unsupported in universal and deferred old-app delivery', (entry) => {
    expect(frozenV1DecodeShareToken(entry.token)).toEqual({
      kind: 'unsupported-version',
      version: 2,
    });
    expect(
      frozenV1DecodeShareToken(
        new URL(`https://openknowledge.ai/d/${entry.token}`).pathname.slice(3),
      ),
    ).toEqual({ kind: 'unsupported-version', version: 2 });
  });
});

/**
 * Pure function — no
 * Electron bindings touched at module top, so Bun runs it directly.
 */

describe('parseOpenKnowledgeUrl — valid inputs', () => {
  test('parses well-formed open/project/doc URL', () => {
    const result = parseOpenKnowledgeUrl('openknowledge://open?project=/abs/path&doc=foo.md');
    expect(result).toEqual({
      host: 'open',
      project: '/abs/path',
      kind: 'doc',
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
      kind: 'doc',
      doc: 'foo bar.md',
    });
  });

  test('parses a folder= deep link with kind folder', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&folder=specs%2Ffoo')).toEqual({
      host: 'open',
      project: '/abs',
      kind: 'folder',
      doc: 'specs/foo',
    });
  });

  test('rejects when BOTH doc and folder are present (ambiguous)', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=a&folder=b')).toBeNull();
  });

  test('rejects when NEITHER doc nor folder is present', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs')).toBeNull();
  });

  test('applies the same traversal defense to folder= as doc=', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&folder=a%2F..%2Fb')).toBeNull();
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&folder=%2Fabs')).toBeNull();
  });

  test('accepts flat doc-name', () => {
    expect(parseOpenKnowledgeUrl('openknowledge://open?project=/abs&doc=a_b-c.md')).toMatchObject({
      doc: 'a_b-c.md',
    });
  });

  test('accepts nested doc-name (common MCP producer shape)', () => {
    // `preview-url.ts` (MCP) emits `doc=<encodeURIComponent(docName)>` where
    // docName is routinely nested — `notes/meeting`, `docs/a`, etc. The
    // parser MUST accept these or the entire MCP deep-link contract breaks.
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
    // `openknowledge:` with no authority part — URL parser may treat as opaque.
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
    // URL.searchParams.get() decodes once ('%2500' → '%00'); decodeURIComponent
    // decodes again ('%00' → '\x00'). The post-decode null-byte recheck must
    // catch it — otherwise a layered encoding would bypass the raw-input gate.
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

/**
 * Locks the producer/consumer contract with `packages/cli/src/mcp/tools/
 * preview-url.ts` — the MCP helper emits
 * `openknowledge://open?project=<encodeURIComponent(realpath)>&doc=<encodeURIComponent(docName)>`
 * for ANY docName (flat, nested, unicode). The parser MUST accept every
 * shape the producer emits, or deep-link routing silently fails for anything
 * other than project-root docs. If a change here breaks round-trip, the
 * MCP contract in preview-url.ts needs an accompanying breaking-change note.
 */
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
    // The producer never emits these, but belt-and-suspenders: simulate a
    // malicious MCP client constructing the URL directly.
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', 'a/../b'))).toBeNull();
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', '../escape'))).toBeNull();
    expect(parseOpenKnowledgeUrl(buildProducerUrl('/abs', '/absolute'))).toBeNull();
  });
});

/**
 * `parseShareUrl` tests — share-flow URL decoder.
 *
 * Pairs with the encoder in `@inkeep/open-knowledge-core` and the
 * blob-URL parser in `@inkeep/open-knowledge`. Two input shapes:
 *
 *   - Universal Link: `https://openknowledge.ai/d/<base64url([0x01]||blob)>`
 *     (and `www.openknowledge.ai`) — version-byte-prefixed payload.
 *   - Custom scheme: `openknowledge://share?url=<urlencoded(<blob-url>)>` —
 *     URL carried directly (no version byte; immediate-handoff path).
 *
 * Both funnel through `parseGitHubBlobUrl` for shape validation; result is
 * `{kind: 'ok' | 'unsupported-version' | 'invalid', source, ...}` for share-
 * shaped inputs, or `null` for anything else (caller falls through to
 * `parseOpenKnowledgeUrl`).
 */
describe('parseShareUrl — universal-link happy path', () => {
  test.each(
    fixture.validShares.filter((entry) => entry.version === 2),
  )('projects canonical $id to its content-relative target', (entry) => {
    expect(parseShareUrl(`https://openknowledge.ai/d/${entry.token}`)).toMatchObject({
      kind: 'ok',
      source: 'universal-link',
      payload: {
        sharedUrl: entry.sharedUrl,
        target: entry.target,
      },
    });
  });

  test.each(fixture.legacyAliases)('preserves tolerated v1 alias $id', (entry) => {
    expect(parseShareUrl(`https://openknowledge.ai/d/${entry.token}`)).toMatchObject({
      kind: 'ok',
      payload: { sharedUrl: entry.sharedUrl },
    });
  });

  test('parses universal-link URL with main branch', () => {
    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/blob/main/marketing.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toEqual({
      kind: 'ok',
      source: 'universal-link',
      dedupKey: '1:https://github.com/inkeep/playbooks/blob/main/marketing.md',
      payload: {
        contentRootDepth: null,
        host: 'github.com',
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        repositoryTarget: { kind: 'doc', docPath: 'marketing.md' },
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
    // Senders MUST percent-encode branch slashes per parseGitHubBlobUrl's
    // contract — the literal `/blob/feat/foo/file.md` form is ambiguous
    // without a network call. The pair (encoder builds sharedUrl with
    // %2F-encoded branch; decoder round-trips it) preserves the slash.
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
  test.each(fixture.invalidTokens)('rejects canonical fixture case $id', (entry) => {
    expect(parseShareUrl(`https://openknowledge.ai/d/${entry.token}`)).toEqual({
      kind: 'invalid',
      source: 'universal-link',
    });
  });

  test('reports unsupported-version for a future payload', () => {
    const future = fixture.unsupportedTokens[0];
    const result = parseShareUrl(`https://openknowledge.ai/d/${future.token}`);
    expect(result).toEqual({
      kind: 'unsupported-version',
      source: 'universal-link',
      version: future.version,
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
    // A GitHub tree URL is a folder share — `parseGitHubShareUrl` resolves it
    // to a `folder` target whose `folderPath` is the directory path.
    const encoded = encodeShareUrl('https://github.com/inkeep/playbooks/tree/main/docs');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}`);
    expect(result).toMatchObject({
      kind: 'ok',
      source: 'universal-link',
      payload: {
        host: 'github.com',
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        target: { kind: 'folder', folderPath: 'docs' },
      },
    });
  });

  test('reports invalid for extra path segments after /d/<encoded>', () => {
    // Path-prefix evolution reserves `/s/`, `/p/`, etc. for future
    // share types. `/d/<encoded>/foo` is NOT a v1 share URL — caller must
    // see an invalid result, not silently take `<encoded>` and ignore the
    // tail.
    const encoded = encodeShareUrl('https://github.com/o/r/blob/main/x.md');
    const result = parseShareUrl(`https://openknowledge.ai/d/${encoded}/extra`);
    expect(result).toEqual({ kind: 'invalid', source: 'universal-link' });
  });
});

describe('parseShareUrl — custom-scheme happy path', () => {
  test('parses the canonical token-only v2 handoff without a second decode', () => {
    const entry = fixture.validShares.find((item) => item.id === 'v2-one-segment-document');
    if (!entry) throw new Error('fixture missing v2-one-segment-document');
    expect(parseShareUrl(`openknowledge://share?token=${entry.token}`)).toMatchObject({
      kind: 'ok',
      source: 'custom-scheme',
      payload: { sharedUrl: entry.sharedUrl, target: entry.target },
    });
  });

  test('parses openknowledge://share?url=<blob-url>', () => {
    const sharedUrl = 'https://github.com/inkeep/playbooks/blob/main/marketing.md';
    const result = parseShareUrl(`openknowledge://share?url=${encodeURIComponent(sharedUrl)}`);
    expect(result).toEqual({
      kind: 'ok',
      source: 'custom-scheme',
      dedupKey: `1:${sharedUrl}`,
      payload: {
        contentRootDepth: null,
        host: 'github.com',
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        repositoryTarget: { kind: 'doc', docPath: 'marketing.md' },
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
  test.each(
    fixture.customSchemeCases.filter((entry) =>
      ['v2-token-plus-url', 'v2-duplicate-token', 'v2-empty-token'].includes(entry.id),
    ),
  )('rejects authoritative malformed token form $id', (entry) => {
    expect(parseShareUrl(entry.uri)).toEqual({ kind: 'invalid', source: 'custom-scheme' });
  });

  test('reports unsupported-version for a future payload token', () => {
    const future = fixture.unsupportedTokens[0];
    const result = parseShareUrl(`openknowledge://share?token=${future.token}`);
    expect(result).toEqual({
      kind: 'unsupported-version',
      source: 'custom-scheme',
      version: future.version,
    });
  });

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
    // `tree/<branch>` with no trailing path denotes the repo/branch root —
    // `parseGitHubShareUrl` yields `folderPath: ''`.
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
    // Caller MUST be able to disambiguate: share-shaped → ShareParseResult,
    // open-shaped → falls through to parseOpenKnowledgeUrl. Returning null
    // here is the contract.
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

  test('classifies malformed share authorities as terminal invalid without claiming lookalikes', () => {
    for (const input of [
      'https://openknowledge.ai:bad/d/secret-token',
      'https://www.openknowledge.ai:99999/d/secret-token',
    ]) {
      expect(parseShareUrl(input)).toEqual({ kind: 'invalid', source: 'universal-link' });
    }
    expect(parseShareUrl('openknowledge://share:bad?token=secret-token')).toEqual({
      kind: 'invalid',
      source: 'custom-scheme',
    });

    expect(parseShareUrl('https://example.com:bad/d/secret-token')).toBeNull();
    expect(parseShareUrl('https://openknowledge.ai@evil.example:bad/d/secret-token')).toBeNull();
    expect(parseShareUrl('openknowledge://shareholder:bad?token=secret-token')).toBeNull();
  });

  test('classifies share-shaped null-byte smuggle attempts as terminal invalid', () => {
    expect(parseShareUrl('https://openknowledge.ai/d/abc\x00')).toEqual({
      kind: 'invalid',
      source: 'universal-link',
    });
    expect(parseShareUrl('https://openknowledge.ai/d/abc%00def')).toEqual({
      kind: 'invalid',
      source: 'universal-link',
    });
    expect(parseShareUrl('openknowledge://share?token=abc%00def')).toEqual({
      kind: 'invalid',
      source: 'custom-scheme',
    });
    expect(parseShareUrl('openknowledge://open?project=/tmp%00secret')).toBeNull();
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
    // %2D → '-', so the encoded form still resolves to install-claude.
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
    // Double-encoded `%2500` decodes to `%00` past the raw-input guard; the
    // allowlist check then rejects the non-member name.
    expect(parseScreenUrl('openknowledge://screen?name=settings%2500')).toBeNull();
  });
});
