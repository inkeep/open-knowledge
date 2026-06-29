import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractMermaidFences,
  setMermaidImporterForTests,
  validateMermaidFences,
} from './mermaid-validator.ts';

afterEach(() => {
  setMermaidImporterForTests(null);
});

describe('extractMermaidFences', () => {
  test('extracts a backtick mermaid fence with its first line', () => {
    const fences = extractMermaidFences('intro\n\n```mermaid\ngraph LR\n  A-->B\n```\n\noutro');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.firstLine).toBe('graph LR');
    expect(fences[0]?.body).toBe('graph LR\n  A-->B');
  });

  test('extracts tilde fences and multiple fences in order', () => {
    const fences = extractMermaidFences(
      '~~~mermaid\npie\n  "a": 1\n~~~\n\n```mermaid\nsequenceDiagram\n  A->>B: x\n```',
    );
    expect(fences.map((f) => f.firstLine)).toEqual(['pie', 'sequenceDiagram']);
  });

  test('ignores non-mermaid fences and near-miss language tokens', () => {
    const fences = extractMermaidFences(
      '```ts\nconst x = 1;\n```\n\n```mermai\ngraph LR\n```\n\n```html preview\n<div/>\n```',
    );
    expect(fences).toHaveLength(0);
  });

  test('does not treat fence-like lines inside a code fence as openers', () => {
    const fences = extractMermaidFences('````md\n```mermaid\nnot a real fence\n```\n````');
    expect(fences).toHaveLength(0);
  });

  test('an unclosed fence runs to end of document (CommonMark)', () => {
    const fences = extractMermaidFences('```mermaid\ngraph LR\n  A-->B');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.body).toBe('graph LR\n  A-->B');
  });

  test('longer closing runs close shorter openers; shorter ones do not', () => {
    const fences = extractMermaidFences('````mermaid\ngraph LR\n```\nstill body\n````');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.body).toBe('graph LR\n```\nstill body');
  });

  test('empty fence yields an empty first line', () => {
    const fences = extractMermaidFences('```mermaid\n```');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.firstLine).toBe('');
  });

  test('CRLF line endings do not defeat fence boundary detection', () => {
    const fences = extractMermaidFences('```mermaid\r\ngraph LR\r\n  A-->B\r\n```\r\nafter');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.firstLine).toBe('graph LR');
    expect(fences[0]?.body).toBe('graph LR\r\n  A-->B\r');
  });
});

describe('validateMermaidFences — real mermaid (type sweep + globals hygiene)', () => {
  const VALID_SAMPLES: Record<string, string> = {
    flowchart: 'graph LR\n  A["Start (quoted)"] --> B[End]',
    sequence: 'sequenceDiagram\n  A->>B: hi',
    class: 'classDiagram\n  class Animal {\n    +name: string\n  }',
    state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Done',
    er: 'erDiagram\n  USER ||--o{ ORDER : places',
    gantt: 'gantt\n  title T\n  section S\n  task1: 2024-01-01, 3d',
    pie: 'pie\n  "a": 40\n  "b": 60',
    mindmap: 'mindmap\n  root((center))\n    child1',
    journey: 'journey\n  title J\n  section S\n    step: 5: Me',
    timeline: 'timeline\n  title H\n  2020 : event',
    gitGraph: 'gitGraph\n  commit\n  branch dev\n  commit',
    quadrant:
      'quadrantChart\n  title Q\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.1, 0.2]',
    requirement: 'requirementDiagram\n  requirement r1 {\n  id: 1\n  text: t\n  }',
    c4: 'C4Context\n  title T\n  Person(p, "P")',
    sankey: 'sankey-beta\n  a,b,10',
    xychart: 'xychart-beta\n  title "T"\n  x-axis [a, b]\n  bar [1, 2]',
    block: 'block-beta\n  a b',
    packet: 'packet-beta\n  0-15: "field"',
    kanban: 'kanban\n  todo\n    t1[task]',
    architecture: 'architecture-beta\n  group api(cloud)[API]',
  };

  test('every sampled diagram type parses without warnings', async () => {
    for (const [name, sample] of Object.entries(VALID_SAMPLES)) {
      const warnings = await validateMermaidFences(
        `# Doc\n\n\`\`\`mermaid\n${sample}\n\`\`\`\n`,
        `sweep-${name}`,
      );
      expect(warnings, `expected no warnings for ${name}`).toBeUndefined();
    }
  });

  test('invalid samples produce line-numbered parse warnings', async () => {
    const invalid: Array<[string, string, string]> = [
      ['sequence', 'sequenceDiagram\n  A->>B: hi; there', 'sequenceDiagram'],
      ['flowchart', 'graph LR\n  A[unclosed --> B', 'graph LR'],
      ['class', 'classDiagram\n  class {{{', 'classDiagram'],
    ];
    for (const [name, sample, firstLine] of invalid) {
      const warnings = await validateMermaidFences(
        `\`\`\`mermaid\n${sample}\n\`\`\``,
        `sweep-invalid-${name}`,
      );
      expect(warnings, `expected a warning for ${name}`).toHaveLength(1);
      const w = warnings?.[0];
      expect(w?.kind).toBe('mermaid-parse-error');
      expect(w?.fenceIndex).toBe(1);
      expect(w?.fenceFirstLine).toBe(firstLine);
      expect(w?.message).toContain('Parse error');
      expect(w?.line).toBeGreaterThan(0);
    }
  });

  test('a typo in the diagram header is a warning (it will not render)', async () => {
    const warnings = await validateMermaidFences('```mermaid\nflowchat LR\n  A-->B\n```', 'typo');
    expect(warnings).toHaveLength(1);
  });

  test('an empty mermaid fence is a warning (no diagram type detected)', async () => {
    const warnings = await validateMermaidFences('```mermaid\n```', 'empty-fence');
    expect(warnings).toHaveLength(1);
  });

  test('only failing fences warn; valid siblings stay silent', async () => {
    const warnings = await validateMermaidFences(
      '```mermaid\ngraph LR\n  A-->B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: x; y\n```',
      'mixed',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]?.fenceIndex).toBe(2);
    expect(warnings?.[0]?.fenceFirstLine).toBe('sequenceDiagram');
  });

  test('frontmatter region is excluded from fence scanning', async () => {
    const warnings = await validateMermaidFences(
      '---\ntitle: t\n---\n\n```mermaid\ngraph LR\n  A-->B\n```',
      'with-fm',
    );
    expect(warnings).toBeUndefined();
  });

  test('the server process keeps clean globals after validator init', async () => {
    await validateMermaidFences('```mermaid\ngraph LR\n A-->B\n```', 'globals');
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  test('docs without mermaid fences return undefined without any work', async () => {
    expect(
      await validateMermaidFences('# Plain doc\n\nNo diagrams here.', 'plain'),
    ).toBeUndefined();
    expect(await validateMermaidFences('mentions mermaid in prose only', 'prose')).toBeUndefined();
  });
});

describe('validateMermaidFences — containment (seamed parser)', () => {
  test('TypeError-class throws are environment skips, not warnings', async () => {
    setMermaidImporterForTests(async () => ({
      parse: async () => {
        throw new TypeError('DOMPurify.addHook is not a function');
      },
    }));
    const warnings = await validateMermaidFences('```mermaid\ngraph LR\n A-->B\n```', 'env-skip');
    expect(warnings).toBeUndefined();
  });

  test('import failure memoizes a permanent no-op (single init attempt)', async () => {
    let attempts = 0;
    setMermaidImporterForTests(() => {
      attempts++;
      return Promise.reject(new Error('platform import failure'));
    });
    const doc = '```mermaid\ngraph LR\n A-->B\n```';
    expect(await validateMermaidFences(doc, 'import-fail-1')).toBeUndefined();
    expect(await validateMermaidFences(doc, 'import-fail-2')).toBeUndefined();
    expect(attempts).toBe(1);
  });

  test('fences over the byte cap are skipped without parsing', async () => {
    let parsed = 0;
    setMermaidImporterForTests(async () => ({
      parse: async () => {
        parsed++;
      },
    }));
    const bigBody = `sequenceDiagram\n${'A'.repeat(100_001)}`;
    const hugeFence = `\`\`\`mermaid\n${bigBody}\n\`\`\``;
    const warnings = await validateMermaidFences(hugeFence, 'byte-cap');
    expect(warnings).toBeUndefined();
    expect(parsed).toBe(0);
  });

  test('fences over the line cap are skipped without parsing', async () => {
    let parsed = 0;
    setMermaidImporterForTests(async () => ({
      parse: async () => {
        parsed++;
      },
    }));
    const hugeFence = `\`\`\`mermaid\ngraph LR\n${'  A-->B\n'.repeat(2_100)}\`\`\``;
    const warnings = await validateMermaidFences(hugeFence, 'line-cap');
    expect(warnings).toBeUndefined();
    expect(parsed).toBe(0);
  });

  test('fences beyond MAX_FENCES_PARSED (20) are not parsed', async () => {
    let parsed = 0;
    setMermaidImporterForTests(async () => ({
      parse: async (body: string) => {
        parsed++;
        if (body.includes('INVALID')) throw new Error('Parse error on line 1: Invalid diagram');
      },
    }));
    const valid = '```mermaid\ngraph LR\n  A-->B\n```\n';
    const invalid = '```mermaid\nINVALID\n```\n';
    const warnings = await validateMermaidFences(valid.repeat(20) + invalid, 'fence-cap');
    expect(warnings).toBeUndefined();
    expect(parsed).toBe(20);
  });

  test('oversized fences do not consume the parse budget', async () => {
    let parsed = 0;
    setMermaidImporterForTests(async () => ({
      parse: async (body: string) => {
        parsed++;
        if (body.includes('INVALID')) throw new Error('Parse error on line 1: Invalid');
      },
    }));
    const oversized = `\`\`\`mermaid\ngraph LR\n${'  A-->B\n'.repeat(2_100)}\`\`\`\n`;
    const invalid = '```mermaid\nINVALID\n```\n';
    const warnings = await validateMermaidFences(oversized.repeat(25) + invalid, 'budget-skip');
    expect(warnings).toHaveLength(1);
    expect(parsed).toBe(1);
  });

  test('warnings are bounded to 10 entries and messages to 500 chars', async () => {
    setMermaidImporterForTests(async () => ({
      parse: async () => {
        throw new Error(`Parse error on line 2:\n${'x'.repeat(2_000)}`);
      },
    }));
    const fence = '```mermaid\nsequenceDiagram\n  A->>B: x; y\n```\n';
    const warnings = await validateMermaidFences(fence.repeat(14), 'bounds');
    expect(warnings).toHaveLength(10);
    expect(warnings?.[0]?.message.length).toBeLessThanOrEqual(500);
    expect(warnings?.[9]?.fenceIndex).toBe(10);
  });
});
