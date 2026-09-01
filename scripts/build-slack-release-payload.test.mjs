import { describe, expect, test } from 'vitest';
import {
  buildSlackReleasePayload,
  chunkForSections,
  githubMarkdownToSlackMrkdwn,
  truncateOnLineBoundary,
} from './build-slack-release-payload.mjs';

const RELEASE_URL = 'https://github.com/inkeep/open-knowledge/releases/tag/v0.38.4';

const SLACK_SECTION_CAP = 3000;

function sectionTexts(payload) {
  return payload.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
}

describe('githubMarkdownToSlackMrkdwn', () => {
  test('converts Changesets level headings to bold (mrkdwn has no headings)', () => {
    expect(githubMarkdownToSlackMrkdwn('### Patch Changes')).toBe('*Patch Changes*');
    expect(githubMarkdownToSlackMrkdwn('## Minor Changes')).toBe('*Minor Changes*');
  });

  test('renders bullets as glyphs and indents the one nesting level Changesets emits', () => {
    const out = githubMarkdownToSlackMrkdwn('- top level\n  - nested point');
    expect(out).toBe('• top level\n    ◦ nested point');
  });

  test('rewrites inline links to Slack link syntax', () => {
    expect(githubMarkdownToSlackMrkdwn('see [the docs](https://example.com/x)')).toBe(
      'see <https://example.com/x|the docs>',
    );
  });

  test('keeps two links on one line separate', () => {
    expect(githubMarkdownToSlackMrkdwn('[a](https://e.com/a) and [b](https://e.com/b)')).toBe(
      '<https://e.com/a|a> and <https://e.com/b|b>',
    );
  });

  test('converts double-asterisk and double-underscore bold to single-asterisk', () => {
    expect(githubMarkdownToSlackMrkdwn('**bold** and __also bold__')).toBe(
      '*bold* and *also bold*',
    );
  });

  test('escapes the three characters Slack reserves in mrkdwn', () => {
    expect(githubMarkdownToSlackMrkdwn('Y.Text<string> & Y.Map')).toBe(
      'Y.Text&lt;string&gt; &amp; Y.Map',
    );
  });

  test('strips the internal consumed-set marker so it never reaches the channel', () => {
    const out = githubMarkdownToSlackMrkdwn('- a change\n\n<!-- ok-consumed-set: ["x"] -->\n');
    expect(out).toBe('• a change');
    expect(out).not.toContain('ok-consumed-set');
  });

  test('strips the Downloads block CONTENT, not just its marker comments', () => {
    const body = [
      '- a change',
      '',
      '<!-- ok-downloads:start -->',
      '## Downloads',
      '',
      '| Platform | Architecture | Download |',
      '| --- | --- | --- |',
      '| Windows | x64 | [OpenKnowledge-Setup-x64.exe](https://example.invalid/x) |',
      '<!-- ok-downloads:end -->',
    ].join('\n');
    const out = githubMarkdownToSlackMrkdwn(body);
    expect(out).toBe('• a change');
    expect(out).not.toContain('Downloads');
    expect(out).not.toContain('|');
  });

  test('passes fenced code through without list or bold rewriting', () => {
    const md = '```js\nconst a = **x**;\n- not a bullet\n```';
    const out = githubMarkdownToSlackMrkdwn(md);
    expect(out).toContain('const a = **x**;');
    expect(out).toContain('- not a bullet');
    expect(out).not.toContain('•');
  });

  test('preserves indented continuation paragraphs under a bullet', () => {
    const md = '- fix: tear down the sibling\n\n  `ok start` spawns a detached process.';
    expect(githubMarkdownToSlackMrkdwn(md)).toBe(
      '• fix: tear down the sibling\n\n  `ok start` spawns a detached process.',
    );
  });

  test('leaves backticked code spans intact', () => {
    expect(githubMarkdownToSlackMrkdwn('run `ok start` now')).toBe('run `ok start` now');
  });

  test('returns empty string for empty input', () => {
    expect(githubMarkdownToSlackMrkdwn('')).toBe('');
  });
});

describe('truncateOnLineBoundary', () => {
  test('returns text untouched when within the limit', () => {
    expect(truncateOnLineBoundary('short', 100)).toBe('short');
  });

  test('cuts on a line boundary and marks the truncation', () => {
    const out = truncateOnLineBoundary('aaaa\nbbbb\ncccc', 9);
    expect(out).toBe('aaaa\nbbbb\n…');
  });

  test('never emits more than the limit plus the marker', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the release notes`).join('\n');
    const out = truncateOnLineBoundary(text, 500);
    expect(out.length).toBeLessThanOrEqual(500 + 2);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('chunkForSections', () => {
  test('returns a single chunk when the text fits', () => {
    expect(chunkForSections('short notes')).toEqual(['short notes']);
  });

  test('returns nothing for empty text', () => {
    expect(chunkForSections('')).toEqual([]);
  });

  test('splits on line boundaries with every chunk under the cap', () => {
    const text = Array.from({ length: 200 }, (_, i) => `• change number ${i}`).join('\n');
    const chunks = chunkForSections(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join('\n')).toBe(text);
  });

  test('hard-slices a single line longer than the limit rather than overflowing', () => {
    const chunks = chunkForSections('x'.repeat(1200), 500);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join('')).toBe('x'.repeat(1200));
  });
});

describe('buildSlackReleasePayload', () => {
  test('includes the release notes body in the message', () => {
    const payload = buildSlackReleasePayload({
      version: '0.38.4',
      releaseUrl: RELEASE_URL,
      notes: '### Patch Changes\n\n- fix: tear down the `ok ui` sibling',
    });
    const texts = sectionTexts(payload);
    expect(texts.some((t) => t.includes('*Patch Changes*'))).toBe(true);
    expect(texts.some((t) => t.includes('• fix: tear down the `ok ui` sibling'))).toBe(true);
  });

  test('keeps the header and the trailing downloads link', () => {
    const payload = buildSlackReleasePayload({
      version: '0.38.4',
      releaseUrl: RELEASE_URL,
      notes: '- a change',
    });
    expect(payload.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '🎉 OpenKnowledge 0.38.4 released', emoji: true },
    });
    expect(payload.blocks.at(-1).text.text).toBe(`*<${RELEASE_URL}|Release notes & downloads>*`);
    expect(payload.text).toBe(`OpenKnowledge 0.38.4 released — ${RELEASE_URL}`);
  });

  test('degrades to the header + link message when notes are unavailable', () => {
    for (const notes of ['', undefined]) {
      const payload = buildSlackReleasePayload({ version: '0.38.4', releaseUrl: RELEASE_URL, notes });
      expect(payload.blocks).toHaveLength(2);
      expect(payload.blocks[0].type).toBe('header');
      expect(payload.blocks[1].text.text).toBe(`*<${RELEASE_URL}|Release notes & downloads>*`);
    }
  });

  test('keeps every section under the Slack cap for an oversized release body', () => {
    const notes = `### Minor Changes\n\n${Array.from(
      { length: 120 },
      (_, i) => `- change ${i}: ${'detail '.repeat(20)}`,
    ).join('\n\n')}`;
    const payload = buildSlackReleasePayload({
      version: '0.39.0',
      releaseUrl: RELEASE_URL,
      notes,
    });
    for (const text of sectionTexts(payload)) {
      expect(text.length).toBeLessThanOrEqual(SLACK_SECTION_CAP);
    }
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    expect(payload.blocks.at(-1).text.text).toContain(RELEASE_URL);
  });

  test('produces a mrkdwn-clean message for a real release body', () => {
    const notes = [
      '### Patch Changes',
      '',
      '- fix: tear down the `ok ui` sibling when `ok start` exits via a signal',
      '',
      '  `ok start` spawns a detached `ok ui` process to serve the editor shell.',
      '  See [the runbook](https://example.com/runbook) for the **full** story.',
    ].join('\n');
    const payload = buildSlackReleasePayload({
      version: '0.38.4',
      releaseUrl: RELEASE_URL,
      notes,
    });
    const body = sectionTexts(payload).join('\n');
    expect(body).not.toMatch(/^#{1,6} /m);
    expect(body).not.toContain('**');
    expect(body).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(body).toContain('<https://example.com/runbook|the runbook>');
  });

  test('payload is JSON-serializable with a quote-bearing version', () => {
    const payload = buildSlackReleasePayload({
      version: '0.38.4"; drop',
      releaseUrl: RELEASE_URL,
      notes: '- a "quoted" change',
    });
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
  });
});
