/**
 * Parse-pool contract tests: worker parse output is byte-identical to the
 * inline `mdManager.parseWithFallback` path, the byte-identity guard in
 * bridge-intake makes stale precomputes structurally harmless, and every
 * pool failure mode degrades to the inline path instead of a hung or
 * wrong write.
 *
 * Equivalence comparisons use canonical JSON text, not deep-strict
 * equality: ProseMirror's `toJSON()` emits `attrs` objects with a null
 * prototype, which the worker's structured-clone transfer normalizes to
 * `Object.prototype`. `schema.nodeFromJSON` reads properties only, so the
 * prototype difference is unobservable downstream — canonical JSON is the
 * "same PM JSON" claim these tests pin.
 *
 * The worker resolves `@inkeep/open-knowledge-core` through the `default`
 * export condition (built dist); run a core build before these tests if
 * core sources changed (turbo's `test` task depends on `^build`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Document } from '@hocuspocus/server';
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { applyAgentMarkdownWrite, prepareAgentMarkdownParse } from './agent-sessions.ts';
import { composeAndWriteRawBody, replaceRawBody } from './bridge-intake.ts';
import { mdManager, schema } from './md-manager.ts';
import {
  _overrideParseTaskTimeoutForTests,
  _overrideParseWorkerUrlForTests,
  destroyParsePool,
  offloadParse,
  PARSE_OFFLOAD_MIN_BYTES,
  precomputeParse,
} from './parse-pool.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Frozen paired-write origin for the primitive-level tests. */
const TEST_ORIGIN = {
  source: 'local',
  context: { origin: 'agent', paired: true },
} as const;

function asDocument(ydoc: Y.Doc, name = 'doc.md'): Document {
  return {
    name,
    awareness: undefined,
    getText: (n: string) => ydoc.getText(n),
    getMap: (n: string) => ydoc.getMap(n),
    getXmlFragment: (n: string) => ydoc.getXmlFragment(n),
    transact: (fn: () => void, origin?: unknown) => ydoc.transact(fn, origin),
    on: ydoc.on.bind(ydoc),
    off: ydoc.off.bind(ydoc),
  } as unknown as Document;
}

function fragmentJson(ydoc: Y.Doc): string {
  return JSON.stringify(
    yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('default'), schema).toJSON(),
  );
}

/** Deterministic feature-rich markdown large enough to cross the offload threshold. */
function largeMarkdown(): string {
  const section = [
    '## Heading with **strong** and _emphasis_ and `code`',
    '',
    'A paragraph with a [link](https://example.com/a) and #tag and [[Wiki Page]].',
    '',
    '- item one',
    '- item two',
    '  - nested',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x: number = 1;',
    '```',
    '',
    '> quoted text',
    '',
  ].join('\n');
  return section.repeat(Math.ceil((PARSE_OFFLOAD_MIN_BYTES * 4) / section.length));
}

/**
 * Byte-exercising fixtures for the worker-vs-inline equivalence sweep.
 * Each hits a different pipeline surface: fallback recovery, PUA
 * sentinels, hard-break trimming (the patched dependency), math, tables,
 * escapes, raw HTML, JSX, reference links.
 */
const EQUIVALENCE_FIXTURES: ReadonlyArray<[string, string]> = [
  ['plain paragraph', 'Just a paragraph.\n'],
  ['heading and setext', '# H1\n\nSetext\n===\n\nBody.\n'],
  ['emphasis nesting', '**bold _nested_ and `code`** tail\n'],
  ['escapes survive', 'not \\*emphasis\\* and a literal \\_underscore\\_\n'],
  ['hard break then spaced text (patched dependency)', 'foo\\\n *bar*\n'],
  ['hard break then whitespace-only text (patched dependency)', 'a\\\n  \nb\n'],
  ['task list', '- [ ] open\n- [x] done\n'],
  ['ordered list renumber source', '3. three\n4. four\n'],
  ['table alignment', '| a | b |\n|:--|--:|\n| 1 | 2 |\n'],
  ['fenced code with lang', '```python\nprint("hi")\n```\n'],
  ['math inline and block', 'Euler: $e^{i\\pi}+1=0$\n\n$$\nx^2\n$$\n'],
  ['wikilink and tag', 'See [[Other Page|alias]] and #topic\n'],
  ['raw inline html', 'line<br/>break and <span>span</span>\n'],
  ['jsx component', '<Callout kind="info">Body text</Callout>\n'],
  ['broken mdx falls back', 'before\n\n<Unclosed attr="x"\n\nafter\n'],
  ['mismatched jsx pair', '<Foo>\ntext\n</Bar>\n'],
  ['reference link', 'See [ref one][r1].\n\n[r1]: https://example.com/r1\n'],
  ['thematic break and blockquote', '---\n\n> quote\n\n---\n'],
  ['crlf-free multi-blank', 'a\n\n\n\nb\n'],
];

afterEach(async () => {
  _overrideParseWorkerUrlForTests(undefined);
  _overrideParseTaskTimeoutForTests(undefined);
  await destroyParsePool();
});

describe('worker parse equivalence', () => {
  test('fixture corpus: worker output is byte-identical to inline parse', async () => {
    for (const [label, fixture] of EQUIVALENCE_FIXTURES) {
      const inline = mdManager.parseWithFallback(fixture);
      const offloaded = await offloadParse(fixture);
      expect(JSON.stringify(offloaded), label).toBe(JSON.stringify(inline));
    }
  }, 60_000);

  test('large generated doc: worker output is byte-identical to inline parse', async () => {
    const md = largeMarkdown();
    const inline = mdManager.parseWithFallback(md);
    const offloaded = await offloadParse(md);
    expect(JSON.stringify(offloaded)).toBe(JSON.stringify(inline));
  }, 60_000);

  test('this file round-trips identically (real-world prose corpus)', async () => {
    const source = readFileSync(resolve(__dirname, 'parse-pool.test.ts'), 'utf8');
    const asMarkdown = `# Source dump\n\n\`\`\`ts\n${source}\n\`\`\`\n`;
    const inline = mdManager.parseWithFallback(asMarkdown);
    const offloaded = await offloadParse(asMarkdown);
    expect(JSON.stringify(offloaded)).toBe(JSON.stringify(inline));
  }, 60_000);

  test('patched dependency behavior holds inside the worker', async () => {
    // The pinned @handlewithcare/remark-prosemirror patch drops a
    // whitespace-only text node after a hard break instead of throwing
    // RangeError from schema.text(''). An unpatched worker install would
    // recover through the whole-doc fallback (a single paragraph of raw
    // text) — assert the structured shape positively so the test fails
    // even if BOTH sides were unpatched.
    const offloaded = await offloadParse('foo\\\n *bar*');
    const paragraph = offloaded.content?.[0];
    expect(paragraph?.type).toBe('paragraph');
    const types = (paragraph?.content ?? []).map((n) => n.type);
    expect(types).toContain('hardBreak');
    const barNode = (paragraph?.content ?? []).find((n) => n.type === 'text' && n.text === 'bar');
    expect(barNode?.marks?.some((m) => m.type === 'emphasis')).toBe(true);
  }, 60_000);

  test('wiki-embed resolution matches inline (two-pass table protocol)', async () => {
    const md = 'Intro paragraph.\n\n![[photo.png]]\n\n![[missing.bin]]\n';
    const resolver = {
      resolveEmbed: (target: string) => (target === 'photo.png' ? 'assets/photo.png' : null),
      resolveSize: (target: string) => (target === 'photo.png' ? 12_345 : null),
      sourcePath: 'docs/page',
    };
    const inline = mdManager.parseWithFallback(md, { ...resolver });
    const offloaded = await offloadParse(md, resolver);
    expect(JSON.stringify(offloaded)).toBe(JSON.stringify(inline));
  }, 60_000);

  test('embed-free doc with a resolver present completes in one pass and matches inline', async () => {
    const md = 'No embeds here, just a [link](https://example.com).\n';
    const resolver = {
      resolveEmbed: () => {
        throw new Error('resolver must not be consulted for an embed-free doc');
      },
      sourcePath: 'docs/page',
    };
    const inline = mdManager.parseWithFallback(md, {
      sourcePath: 'docs/page',
      resolveEmbed: () => null,
    });
    const offloaded = await offloadParse(md, resolver);
    expect(JSON.stringify(offloaded)).toBe(JSON.stringify(inline));
  }, 60_000);
});

describe('precomputeParse threshold and fallback', () => {
  test('small docs stay inline (returns undefined)', async () => {
    const result = await precomputeParse('# tiny\n\nbody\n');
    expect(result).toBeUndefined();
  });

  test('large docs offload and carry the exact rawContent', async () => {
    const raw = `---\ntitle: X\n---\n\n${largeMarkdown()}`;
    const result = await precomputeParse(raw);
    expect(result).toBeDefined();
    expect(result?.rawContent).toBe(raw);
    const inline = mdManager.parseWithFallback(stripFrontmatter(raw).body);
    expect(JSON.stringify(result?.parsedJson)).toBe(JSON.stringify(inline));
  }, 60_000);

  test('worker file unavailable degrades to undefined (inline fallback)', async () => {
    _overrideParseWorkerUrlForTests(null);
    const result = await precomputeParse(largeMarkdown());
    expect(result).toBeUndefined();
  });

  test('worker spawn failure degrades to undefined (inline fallback)', async () => {
    _overrideParseWorkerUrlForTests(pathToFileURL(resolve(__dirname, 'no-such-worker.mjs')));
    const result = await precomputeParse(largeMarkdown());
    expect(result).toBeUndefined();
  }, 60_000);

  test('task timeout degrades to undefined, then the pool recovers', async () => {
    _overrideParseTaskTimeoutForTests(1);
    const timedOut = await precomputeParse(largeMarkdown());
    expect(timedOut).toBeUndefined();
    _overrideParseTaskTimeoutForTests(undefined);
    const recovered = await precomputeParse(largeMarkdown());
    expect(recovered).toBeDefined();
  }, 60_000);

  test('destroyParsePool terminates workers and the next dispatch respawns', async () => {
    const before = await precomputeParse(largeMarkdown());
    expect(before).toBeDefined();
    await destroyParsePool();
    const after = await precomputeParse(largeMarkdown());
    expect(after).toBeDefined();
  }, 60_000);
});

describe('bridge-intake byte-identity guard', () => {
  test('a stale precompute is discarded (inline parse applies the real bytes)', () => {
    const raw = '# Real\n\nreal body\n';
    const staleParse = mdManager.parseWithFallback('# Impostor\n\nimpostor body\n');
    const withStale = new Y.Doc();
    withStale.transact(() => {
      composeAndWriteRawBody(withStale, raw, 'agent', undefined, {
        rawContent: '# Impostor\n\nimpostor body\n',
        parsedJson: staleParse,
      });
    }, TEST_ORIGIN);
    const control = new Y.Doc();
    control.transact(() => {
      composeAndWriteRawBody(control, raw, 'agent');
    }, TEST_ORIGIN);
    expect(withStale.getText('source').toString()).toBe(raw);
    expect(fragmentJson(withStale)).toBe(fragmentJson(control));
  });

  test('a byte-matching precompute is honored (observable via a divergent parse)', () => {
    // Production precomputes always hold a true parse of rawContent; the
    // deliberately-divergent JSON here is the only way to OBSERVE which
    // branch applied. A matching rawContent must use the supplied parse.
    const raw = '# Real\n\nreal body\n';
    const divergent = mdManager.parseWithFallback('# Marker heading only\n');
    const doc = new Y.Doc();
    doc.transact(() => {
      replaceRawBody(doc, raw, undefined, { rawContent: raw, parsedJson: divergent });
    }, TEST_ORIGIN);
    // Y.Text still receives the raw bytes verbatim (precedent #38) —
    // only the fragment derivation consumed the precompute.
    expect(doc.getText('source').toString()).toBe(raw);
    expect(fragmentJson(doc)).toContain('Marker heading only');
  });
});

describe('prepareAgentMarkdownParse end-to-end', () => {
  test('fresh precompute: applied write matches the inline-path control byte-for-byte', async () => {
    const md = largeMarkdown();
    const prepared = new Y.Doc();
    const preparedDoc = asDocument(prepared);
    const precomputed = await prepareAgentMarkdownParse(preparedDoc, md, 'replace');
    expect(precomputed).toBeDefined();
    prepared.transact(() => {
      applyAgentMarkdownWrite(preparedDoc, md, 'replace', undefined, precomputed);
    }, TEST_ORIGIN);

    const control = new Y.Doc();
    const controlDoc = asDocument(control);
    control.transact(() => {
      applyAgentMarkdownWrite(controlDoc, md, 'replace');
    }, TEST_ORIGIN);

    expect(prepared.getText('source').toString()).toBe(control.getText('source').toString());
    expect(fragmentJson(prepared)).toBe(fragmentJson(control));
  }, 60_000);

  test('doc moved during the await: stale precompute discarded, write still correct', async () => {
    const md = largeMarkdown();
    const ydoc = new Y.Doc();
    const doc = asDocument(ydoc);
    const precomputed = await prepareAgentMarkdownParse(doc, md, 'append');
    expect(precomputed).toBeDefined();
    // A concurrent writer lands between the precompute and the transact.
    ydoc.transact(() => {
      ydoc.getText('source').insert(0, '# Raced-in heading\n\n');
    }, TEST_ORIGIN);
    ydoc.transact(() => {
      applyAgentMarkdownWrite(doc, md, 'append', undefined, precomputed);
    }, TEST_ORIGIN);

    const control = new Y.Doc();
    const controlDoc = asDocument(control);
    control.transact(() => {
      control.getText('source').insert(0, '# Raced-in heading\n\n');
    }, TEST_ORIGIN);
    control.transact(() => {
      applyAgentMarkdownWrite(controlDoc, md, 'append');
    }, TEST_ORIGIN);

    expect(ydoc.getText('source').toString()).toBe(control.getText('source').toString());
    expect(fragmentJson(ydoc)).toBe(fragmentJson(control));
  }, 60_000);

  test('no-op composition (empty append) returns undefined without dispatching', async () => {
    const ydoc = new Y.Doc();
    const result = await prepareAgentMarkdownParse(asDocument(ydoc), '', 'append');
    expect(result).toBeUndefined();
  });
});

describe('worker entry ships in every bundle shape', () => {
  // Build-config source assertions (the runtime alternative is running two
  // full tsdown builds per test run). Same justification as the sibling
  // tsdown-bundle-coverage test: dist shape is decided entirely by these
  // configs, and the parse pool's sibling probe depends on the entry name.
  test('server tsdown config emits the parse-worker entry', () => {
    const config = readFileSync(resolve(__dirname, '../tsdown.config.ts'), 'utf8');
    expect(config).toMatch(/'parse-worker':\s*'src\/parse-worker\.ts'/);
  });

  test('cli tsdown config emits the parse-worker entry next to dist/cli.mjs', () => {
    const config = readFileSync(resolve(__dirname, '../../cli/tsdown.config.ts'), 'utf8');
    expect(config).toMatch(/'parse-worker':\s*'src\/parse-worker\.ts'/);
  });

  test('server package.json exports the parse-worker subpath for both conditions', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports['./parse-worker']).toEqual({
      development: './src/parse-worker.ts',
      types: './src/parse-worker.ts',
      default: './dist/parse-worker.mjs',
    });
  });
});
