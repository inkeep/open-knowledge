import { describe, expect, test } from 'bun:test';
import {
  composeTemplateFile,
  instantiateDoc,
  parseTemplateFile,
  TEMPLATE_IDENTITY_KEY,
} from './template-format.ts';

const SINGLE_BLOCK = `---
template:
  title: Research Log
  description: Provisional analysis synthesizing external sources.
status: provisional
sources: []
created: {{date}}
author: {{user}}
tags: [research, provisional]
---

## Question

## Sources cited
`;

const LEGACY_TWO_BLOCK = `---
title: Research Log
description: Provisional analysis synthesizing external sources.
---
---
status: provisional
sources: []
created: {{date}}
author: {{user}}
tags: [research, provisional]
---

## Question

## Sources cited
`;

describe('parseTemplateFile', () => {
  test('parses a single-block template: identity from template:, doc-fm as starter content', () => {
    const m = parseTemplateFile(SINGLE_BLOCK);
    expect(m.identity.title).toBe('Research Log');
    expect(m.identity.description).toContain('Provisional analysis');
    // starterContent is the doc-frontmatter block + markdown the new doc gets.
    expect(m.starterContent).toContain('status: provisional');
    expect(m.starterContent).toContain('## Question');
    // identity keys do NOT leak into starter content.
    expect(m.starterContent).not.toContain('title: Research Log');
    expect(m.starterContent).not.toContain(`${TEMPLATE_IDENTITY_KEY}:`);
  });

  test('strips a leading UTF-8 BOM so identity is not lost', () => {
    const m = parseTemplateFile(`\uFEFF${SINGLE_BLOCK}`);
    expect(m.identity.title).toBe('Research Log');
    expect(m.starterContent).toContain('## Question');
  });

  test('handles a blank line inside the template: identity block', () => {
    const raw = `---\ntemplate:\n  title: T\n\n  description: D\nstatus: provisional\n---\n\n## Body\n`;
    const m = parseTemplateFile(raw);
    expect(m.identity.title).toBe('T');
    expect(m.identity.description).toBe('D');
    // The doc-frontmatter after the identity block is not swallowed into it.
    expect(m.starterContent).toContain('status: provisional');
    expect(m.starterContent).not.toContain('title: T');
  });

  test('parses a legacy two-block template to the SAME logical model', () => {
    const legacy = parseTemplateFile(LEGACY_TWO_BLOCK);
    const modern = parseTemplateFile(SINGLE_BLOCK);
    expect(legacy.identity.title).toBe(modern.identity.title);
    expect(legacy.identity.description).toBe(modern.identity.description);
    // Both produce starter content carrying the doc frontmatter + body.
    expect(legacy.starterContent).toContain('status: provisional');
    expect(legacy.starterContent).toContain('## Question');
    expect(legacy.starterContent).not.toContain('title: Research Log');
  });

  test('never throws on malformed yaml', () => {
    const broken = `---\ntemplate:\n  title: X\nbad: a: b: c\n---\n\nbody`;
    expect(() => parseTemplateFile(broken)).not.toThrow();
  });
});

describe('composeTemplateFile + round-trip', () => {
  test('compose produces a single block with template: first and no second fence', () => {
    const m = parseTemplateFile(SINGLE_BLOCK);
    const composed = composeTemplateFile(m.identity, m.starterContent);
    // exactly one frontmatter block (one leading ---, one closing ---)
    const fenceCount = (composed.match(/^---[ \t]*$/gm) ?? []).length;
    expect(fenceCount).toBe(2);
    expect(composed).toContain(`${TEMPLATE_IDENTITY_KEY}:`);
    expect(composed).toContain('status: provisional');
    expect(composed).toContain('## Question');
  });

  test('parse -> compose -> parse is stable (idempotent model)', () => {
    const m1 = parseTemplateFile(SINGLE_BLOCK);
    const composed = composeTemplateFile(m1.identity, m1.starterContent);
    const m2 = parseTemplateFile(composed);
    expect(m2.identity.title).toBe(m1.identity.title);
    expect(m2.starterContent.trim()).toBe(m1.starterContent.trim());
  });

  test('migrates legacy -> single block on compose', () => {
    const legacy = parseTemplateFile(LEGACY_TWO_BLOCK);
    const composed = composeTemplateFile(legacy.identity, legacy.starterContent);
    const fenceCount = (composed.match(/^---[ \t]*$/gm) ?? []).length;
    expect(fenceCount).toBe(2); // single block, not the legacy two
    expect(parseTemplateFile(composed).identity.title).toBe('Research Log');
  });
});

describe('instantiateDoc', () => {
  test('new doc = doc-frontmatter + markdown, identity stripped', () => {
    const doc = instantiateDoc(SINGLE_BLOCK);
    expect(doc).toContain('status: provisional');
    expect(doc).toContain('## Question');
    expect(doc).not.toContain('title: Research Log');
    expect(doc).not.toContain(`${TEMPLATE_IDENTITY_KEY}:`);
    // {{date}}/{{user}} survive (substitution is the caller's job).
    expect(doc).toContain('{{date}}');
  });

  test('legacy template instantiates to the same doc shape', () => {
    const doc = instantiateDoc(LEGACY_TWO_BLOCK);
    expect(doc).toContain('status: provisional');
    expect(doc).toContain('## Question');
    expect(doc).not.toContain('title: Research Log');
  });
});
