/**
 * The frontmatter validator is isomorphic: the editor runs it client-side via
 * `useDocDiagnostics` -> `lintDocument`, so the 2019-09 and 2020-12 ajv entry
 * points are bundled into the browser build, not just the server. Both are
 * CommonJS, and the compile path swallows a failure to `null` — so a
 * module-interop break in the client realm would surface as *zero* frontmatter
 * diagnostics in the editor while `ok lint`, the HTTP API, and MCP all keep
 * working. That asymmetry is invisible without a test that constructs the
 * engines outside Node's realm.
 *
 * It mounts a probe that awaits `lintDocument` in an effect and renders the
 * resulting codes — the same shape `useDocDiagnostics` uses — rather than
 * calling the validator inline, so the engines are exercised through a real
 * React render in jsdom. Asserting concrete codes (not merely "it didn't
 * throw") is what makes it discriminating: the swallow-to-null path yields an
 * empty array, exactly what a broken engine produces.
 */

import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  lintDocument,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(cleanup);

const DOC_NAME = 'docs/guide';
const PENDING = 'pending';

function configFor(schema: Record<string, unknown>): LinterConfig {
  return {
    ...DEFAULT_LINTER_CONFIG,
    enabled: true,
    plugins: {
      ...DEFAULT_LINTER_CONFIG.plugins,
      markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: false },
      frontmatter: {
        enabled: true,
        schemas: [{ appliesTo: 'docs/**', file: '.ok/schemas/probe.schema.json', schema }],
      },
    },
  };
}

/** Mirrors how `useDocDiagnostics` drives the linter: await it in an effect. */
function DiagnosticsProbe({ text, schema }: { text: string; schema: Record<string, unknown> }) {
  const [codes, setCodes] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void lintDocument(text, configFor(schema), DOC_NAME).then((diagnostics) => {
      if (cancelled) return;
      setCodes(
        diagnostics
          .filter((d) => d.source === 'frontmatter')
          .map((d) => d.code)
          .sort()
          .join(','),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [text, schema]);
  return <output data-testid="codes">{codes ?? PENDING}</output>;
}

async function mountAndReadCodes(text: string, schema: Record<string, unknown>): Promise<string> {
  render(<DiagnosticsProbe text={text} schema={schema} />);
  const node = await screen.findByTestId('codes');
  // The probe starts at PENDING; wait for the effect's promise to land so an
  // engine that never resolves fails here instead of reading as "no findings".
  await expect.poll(() => node.textContent).not.toBe(PENDING);
  return node.textContent ?? '';
}

describe('frontmatter dialects in the client realm', () => {
  test('jsdom is the active environment (guards against a silent node-realm run)', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  test('2020-12 compiles and validates client-side (prefixItems + asserted format)', async () => {
    const doc = ['---', 'reviewedAt: not-a-date', 'pair:', '  - ok', '  - nope', '---'].join('\n');
    // `format` proves ajv-formats attached to the 2020-12 instance; `type` on
    // `pair.1` proves prefixItems (a 2020-12-only keyword) actually compiled.
    expect(
      await mountAndReadCodes(doc, {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          reviewedAt: { type: 'string', format: 'date' },
          pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
        },
      }),
    ).toBe('format,type');
  });

  test('2019-09 compiles and validates client-side (dependentRequired + $defs/$ref)', async () => {
    expect(
      await mountAndReadCodes('---\nslug: Bad Slug\n---\n', {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        $defs: { Slug: { type: 'string', pattern: '^[a-z-]+$' } },
        properties: { slug: { $ref: '#/$defs/Slug' } },
        dependentRequired: { slug: ['owner'] },
      }),
    ).toBe('dependentRequired,pattern');
  });

  test.each([
    'http://json-schema.org/draft-06/schema#',
    'http://json-schema.org/draft-07/schema#',
  ])('%s still validates client-side', async ($schema) => {
    expect(
      await mountAndReadCodes('---\nweight: 5\n---\n', {
        $schema,
        type: 'object',
        properties: { weight: { type: 'number', exclusiveMinimum: 5 } },
      }),
    ).toBe('exclusiveMinimum');
  });
});
