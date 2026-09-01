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
    expect(screen.getByTestId('property-problem-badge')).toBeTruthy();
    expect(screen.getByTestId('property-problem-badge').textContent).toBe('1');
  });

  test('still unmounts on a clean document with no properties', async () => {
    diagnostics = [];
    await renderPanel(makeProvider('clean-no-properties'));
    expect(screen.queryByTestId('property-panel')).toBeNull();
  });
});
