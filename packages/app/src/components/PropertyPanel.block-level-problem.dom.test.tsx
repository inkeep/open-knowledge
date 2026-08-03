/**
 * A schema can constrain the frontmatter block as a whole — `minProperties`, a
 * root `anyOf`, `not` — rather than any single property. Those fire against an
 * empty object, so they name no property row.
 *
 * The panel unmounts itself when a document has no properties to show. Since
 * the body no longer marks frontmatter violations, that unmount would leave a
 * block-level violation with NO editor surface at all — strictly less visible
 * than before, when it (wrongly) squiggled the first body block. These pin that
 * the panel stays mounted to carry its badge whenever one is outstanding.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

const blockLevelProblem = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: 'warning' as const,
  source: 'frontmatter' as const,
  code: 'minProperties',
  message: 'Frontmatter must NOT have fewer than 1 properties',
  frontmatterScope: 'invalid' as const,
};

let diagnostics: unknown[] = [];

vi.doMock('@/editor/useFrontmatterDiagnostics', async () => {
  const actual = await vi.importActual<typeof import('@/editor/useFrontmatterDiagnostics')>(
    '@/editor/useFrontmatterDiagnostics',
  );
  return { ...actual, useFrontmatterDiagnostics: () => diagnostics };
});

const providers: HocuspocusProvider[] = [];

function makeProvider(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: 'ws://localhost:1/collab', name: docName });
  providers.push(p);
  return p;
}

async function renderPanel(provider: HocuspocusProvider) {
  const { PropertyProvider } = await import('./PropertyContext');
  const { PropertyPanel } = await import('./PropertyPanel');
  render(
    <TooltipProvider>
      <PropertyProvider>
        <PropertyPanel provider={provider} />
      </PropertyProvider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  diagnostics = [];
  for (const p of providers.splice(0)) p.destroy();
});

describe('PropertyPanel with a block-level frontmatter problem', () => {
  test('stays mounted for its badge when the document has no properties', async () => {
    diagnostics = [blockLevelProblem];
    await renderPanel(makeProvider('block-level-problem'));
    // Without the guard the panel returns null here and the violation has no
    // editor surface at all.
    expect(screen.getByTestId('property-problem-badge')).toBeTruthy();
    expect(screen.getByTestId('property-problem-badge').textContent).toBe('1');
  });

  test('still unmounts on a clean document with no properties', async () => {
    diagnostics = [];
    await renderPanel(makeProvider('clean-no-properties'));
    // The guard must not turn into "always render" — an empty panel on every
    // property-less document would be noise.
    expect(screen.queryByTestId('property-panel')).toBeNull();
  });
});
