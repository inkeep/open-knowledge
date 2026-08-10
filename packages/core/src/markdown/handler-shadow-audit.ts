export interface HandlerShadowWitness {
  input: string;
  expect: 'byte' | 'byte-and-reparse-type';
  reparseType?: string;
}

export interface HandlerShadowAdjudication {
  shadows: string;
  obligation: string;
  witnesses: ReadonlyArray<HandlerShadowWitness>;
}

export const HANDLER_SHADOW_ADJUDICATIONS: Record<string, HandlerShadowAdjudication> = {
  delete: {
    shadows: 'mdast-util-gfm-strikethrough handlers.delete (via remark-gfm)',
    obligation:
      'emit tilde-delimited strikethrough; OK additionally re-emits the captured source ' +
      'delimiter so single-tilde forms survive',
    witnesses: [
      { input: 'a ~~b~~ c', expect: 'byte' },
      { input: 'a ~b~ c', expect: 'byte' },
    ],
  },
  inlineCode: {
    shadows: 'mdast-util-gfm-table inlineCodeWithTable (via remark-gfm)',
    obligation:
      'inside a tableCell, re-escape | in the emitted code span (GFM: an unescaped pipe splits ' +
      'the cell, so dropping the escape re-parses the table as a paragraph); outside tables, ' +
      'preserve fence char/length and padding',
    witnesses: [
      {
        input: '| `a\\|b` |\n| - |',
        expect: 'byte-and-reparse-type',
        reparseType: 'table',
      },
      { input: 'x `a|b` y', expect: 'byte' },
    ],
  },
  inlineMath: {
    shadows: 'mdast-util-math handlers.inlineMath (via remark-math)',
    obligation:
      'emit dollar-delimited inline math with upstream sizing/padding; OK additionally re-emits ' +
      'the captured single-dollar source form when the currency-safe promoter re-accepts it',
    witnesses: [
      { input: '$$x$$', expect: 'byte' },
      { input: '$x$', expect: 'byte' },
    ],
  },
  mdxJsxFlowElement: {
    shadows: 'mdast-util-mdx-jsx handlers.mdxJsxFlowElement (via the mdx utilities)',
    obligation:
      'serialize JSX flow elements (name, attributes, children) as parseable MDX; OK re-emits ' +
      'captured source for byte fidelity',
    witnesses: [{ input: '<Callout type="info">\nbody\n</Callout>', expect: 'byte' }],
  },
  mdxJsxTextElement: {
    shadows: 'mdast-util-mdx-jsx handlers.mdxJsxTextElement (via the mdx utilities)',
    obligation:
      'serialize inline JSX elements as parseable MDX; OK re-emits captured source for byte fidelity',
    witnesses: [{ input: 'a <File name="x" /> b', expect: 'byte' }],
  },
  table: {
    shadows: 'mdast-util-gfm-table handlers.table (via remark-gfm)',
    obligation:
      'emit the GFM table grid (header, delimiter row, body; cell |-escaping; alignment ' +
      'markers); OK additionally threads captured padding/dash/outer-pipe source forms',
    witnesses: [
      {
        input: '| a | b |\n| --- | --- |\n| 1 | 2 |',
        expect: 'byte-and-reparse-type',
        reparseType: 'table',
      },
      {
        input: '| l | r |\n| :-- | --: |\n| 1 | 2 |',
        expect: 'byte-and-reparse-type',
        reparseType: 'table',
      },
    ],
  },
};

export function collectExtensionHandlerKeys(extensions: readonly unknown[]): string[] {
  const keys = new Set<string>();
  const visit = (ext: unknown): void => {
    if (ext === null || typeof ext !== 'object') return;
    const rec = ext as { handlers?: unknown; extensions?: unknown };
    if (rec.handlers !== null && typeof rec.handlers === 'object') {
      for (const key of Object.keys(rec.handlers as Record<string, unknown>)) keys.add(key);
    }
    if (Array.isArray(rec.extensions)) rec.extensions.forEach(visit);
  };
  extensions.forEach(visit);
  return [...keys].sort();
}

export function computeShadowedHandlerKeys(
  extensionHandlerKeys: readonly string[],
  overrideKeys: readonly string[],
): string[] {
  const overrides = new Set(overrideKeys);
  return extensionHandlerKeys.filter((key) => overrides.has(key)).sort();
}
