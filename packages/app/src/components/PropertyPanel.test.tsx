import { afterEach, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PropertyProvider } from './PropertyContext';
import { PropertyPanel } from './PropertyPanel';

function renderPanel(provider: HocuspocusProvider): string {
  return renderToString(
    <TooltipProvider>
      <PropertyProvider>
        <PropertyPanel provider={provider} />
      </PropertyProvider>
    </TooltipProvider>,
  );
}

const DUMMY_WS = 'ws://localhost:1/collab';

const providers: HocuspocusProvider[] = [];
function makeProvider(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: DUMMY_WS, name: docName });
  providers.push(p);
  return p;
}

afterEach(() => {
  for (const p of providers.splice(0)) {
    try {
      p.destroy();
    } catch {
    }
  }
});

function seedYTextFm(provider: HocuspocusProvider, fenced: string): void {
  const ytext = provider.document.getText('source');
  provider.document.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, fenced);
  });
}

describe('PropertyPanel', () => {
  test('renders nothing when the doc has no frontmatter', () => {
    const provider = makeProvider('empty-doc');
    const html = renderPanel(provider);
    expect(html).toBe('');
  });

  test('renders Properties header + one row per FM property', () => {
    const provider = makeProvider('populated-doc');
    seedYTextFm(provider, '---\ntitle: Hello\ndraft: false\nversion: 3\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('>Properties<');
    expect(html).toContain('data-testid="property-panel"');
    expect(html).toContain('data-key="title"');
    expect(html).toContain('data-key="draft"');
    expect(html).toContain('data-key="version"');
  });

  test('panel header is an aria-expanded button (collapse affordance)', () => {
    const provider = makeProvider('collapsible-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('aria-expanded="true"');
  });

  test('rows are visible by default (panel mounts expanded)', () => {
    const provider = makeProvider('default-expanded-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="property-row"');
  });
});

describe('PropertyPanel widget routing', () => {
  test('text-shape value renders TextWidget', () => {
    const provider = makeProvider('text-doc');
    seedYTextFm(provider, '---\ntitle: My Title\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="text"');
    expect(html).toContain('data-testid="text-widget"');
    expect(html).toContain('>My Title</textarea>');
  });

  test('number-shape value renders NumberWidget', () => {
    const provider = makeProvider('number-doc');
    seedYTextFm(provider, '---\nversion: 7\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="number"');
    expect(html).toContain('data-testid="number-widget"');
    expect(html).toContain('type="number"');
  });

  test('boolean-shape value renders BooleanWidget (Switch)', () => {
    const provider = makeProvider('boolean-doc');
    seedYTextFm(provider, '---\ndraft: false\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="boolean"');
    expect(html).toContain('data-testid="boolean-widget"');
  });

  test('ISO date string renders DateWidget', () => {
    const provider = makeProvider('date-doc');
    seedYTextFm(provider, '---\npublished: 2026-04-24\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="date"');
    expect(html).toContain('data-testid="date-widget"');
    expect(html).toContain('Apr 24, 2026');
  });

  test('list-shape value renders ListWidget with chips', () => {
    const provider = makeProvider('list-doc');
    seedYTextFm(provider, '---\ntags:\n  - docs\n  - crdt\n  - mcp\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="list"');
    expect(html).toContain('data-testid="list-widget"');
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="1"');
    expect(html).toContain('data-index="2"');
    expect(html).toContain('docs');
    expect(html).toContain('crdt');
    expect(html).toContain('mcp');
  });

  test('value-shape wins: array always renders as list, even if declared was text', () => {
    const provider = makeProvider('shape-wins-doc');
    seedYTextFm(provider, '---\ntopics:\n  - a\n  - b\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-widget-type="list"');
  });

  test('type icon button is per-row + matches inferred type', () => {
    const provider = makeProvider('type-icon-doc');
    seedYTextFm(provider, '---\ntitle: Hello\ncount: 5\n---\n');
    const html = renderPanel(provider);
    const iconMatches = html.match(/data-testid="type-icon-button"/g) ?? [];
    expect(iconMatches.length).toBe(2);
    expect(html).toContain('data-key="title"');
    expect(html).toContain('aria-label="title type: Text. Click to change."');
    expect(html).toContain('aria-label="count type: Number. Click to change."');
  });
});

describe('PropertyPanel row chrome', () => {
  test('each row renders a remove button with key-scoped aria-label', () => {
    const provider = makeProvider('chrome-remove-doc');
    seedYTextFm(provider, '---\ntitle: A\nstatus: draft\n---\n');
    const html = renderPanel(provider);
    const trashMatches = html.match(/data-testid="property-remove-button"/g) ?? [];
    expect(trashMatches.length).toBe(2);
    expect(html).toContain('aria-label="Remove title"');
    expect(html).toContain('aria-label="Remove status"');
  });

  test('property name renders as a button (rename affordance)', () => {
    const provider = makeProvider('chrome-rename-doc');
    seedYTextFm(provider, '---\ntitle: A\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="property-name-button"');
    expect(html).toContain('data-key="title"');
  });

  test('each row renders a drag handle with key-scoped aria-label (FR4 + FR5)', () => {
    const provider = makeProvider('chrome-move-doc');
    seedYTextFm(provider, '---\ntitle: A\nstatus: draft\n---\n');
    const html = renderPanel(provider);
    const dragHandles = html.match(/data-testid="property-drag-handle"/g) ?? [];
    expect(dragHandles.length).toBe(2);
    expect(html).toContain('aria-label="Drag title to reorder"');
    expect(html).toContain('aria-label="Drag status to reorder"');
  });
});

describe('PropertyPanel tags placeholder row', () => {
  test('renders the placeholder row when `tags` key is absent from YAML', () => {
    const provider = makeProvider('tags-absent-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="property-placeholder-name"');
    expect(html).toContain('data-testid="property-placeholder-icon"');
    expect(html).toContain('data-key="tags"');
    const placeholderName = html.match(
      /data-testid="property-placeholder-name"[^>]*data-key="tags"/,
    );
    expect(placeholderName).not.toBeNull();
  });

  test('does NOT render the placeholder when `tags: []` is in YAML (explicit empty)', () => {
    const provider = makeProvider('tags-empty-array-doc');
    seedYTextFm(provider, '---\ntags: []\n---\n');
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-placeholder-name"');
    expect(html).toContain('data-widget-type="list"');
    expect(html).toContain('data-key="tags"');
  });

  test('does NOT render the placeholder when `tags: [foo]` is in YAML (populated)', () => {
    const provider = makeProvider('tags-populated-doc');
    seedYTextFm(provider, '---\ntags:\n  - foo\n---\n');
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-placeholder-name"');
    expect(html).toContain('data-widget-type="list"');
    expect(html).toContain('data-key="tags"');
  });

  test('placeholder identity column dims via muted-foreground/60 (visual placeholder cue)', () => {
    const provider = makeProvider('tags-styling-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('text-muted-foreground/60');
  });
});

describe('PropertyPanel add-property trigger', () => {
  test('persistent add-property button at the bottom of the expanded panel', () => {
    const provider = makeProvider('add-trigger-doc');
    seedYTextFm(provider, '---\ntitle: A\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="add-property-trigger"');
    expect(html).toContain('>Add<');
    expect(html).not.toMatch(/>Add property</);
    const triggerTagMatch = html.match(/<[^>]*data-testid="add-property-trigger"[^>]*>/);
    expect(triggerTagMatch).not.toBeNull();
    expect(triggerTagMatch?.[0]).not.toContain('pl-7');
    expect(triggerTagMatch?.[0]).toContain('px-2');
    const spacerIdx = html.search(/<span\s+aria-hidden[^>]*class="h-7 w-4 shrink-0"/);
    const triggerIdx = html.indexOf('data-testid="add-property-trigger"');
    expect(spacerIdx).toBeGreaterThan(-1);
    expect(spacerIdx).toBeLessThan(triggerIdx);
  });

  test('the add-property trigger carries `aria-label="Add property"` for screen readers', () => {
    const provider = makeProvider('add-trigger-aria-doc');
    seedYTextFm(provider, '---\ntitle: A\n---\n');
    const html = renderPanel(provider);
    const triggerTagMatch = html.match(/<[^>]*data-testid="add-property-trigger"[^>]*>/);
    expect(triggerTagMatch).not.toBeNull();
    expect(triggerTagMatch?.[0]).toMatch(/aria-label="Add property"/);
  });

  test('panel is hidden when there are no rows AND no add-row open', () => {
    const provider = makeProvider('add-trigger-empty-doc');
    const html = renderPanel(provider);
    expect(html).toBe('');
  });
});

describe('PropertyPanel duplicate-name surfacing', () => {
  test('two rows with the same name both render with a duplicate-name marker (D17/FR6)', () => {
    const provider = makeProvider('dup-name-doc');
    seedYTextFm(provider, '---\ntitle: First\ntitle: Second\n---\n');
    const html = renderPanel(provider);
    const dupMarkerMatches = html.match(/data-testid="property-duplicate-marker"/g) ?? [];
    expect(dupMarkerMatches.length).toBe(2);
  });
});

describe('PropertyPanel malformed YAML banner (FR9)', () => {
  test('renders an inline banner when the YAML region is unparseable', () => {
    const provider = makeProvider('malformed-yaml-doc');
    seedYTextFm(provider, '---\n: : : invalid\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="property-panel-yaml-error"');
    expect(html).toContain('properties block at the top of this doc has a formatting error');
  });

  test('does not show YAML-malformed banner when array contains non-string scalars', () => {
    const provider = makeProvider('mixed-scalar-array-doc');
    seedYTextFm(provider, '---\ntags: [travel, spain, 2026]\n---\n');
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-panel-yaml-error"');
    expect(html).toContain('data-widget-type="list"');
    expect(html).toContain('data-index="0"');
    expect(html).toContain('data-index="1"');
    expect(html).toContain('data-index="2"');
    expect(html).toContain('travel');
    expect(html).toContain('spain');
    expect(html).toContain('2026');
  });
});

describe('PropertyPanel nested-value rendering', () => {
  test('skill-shaped nested frontmatter renders every top-level row + no banner', () => {
    const provider = makeProvider('nested-skill-doc');
    seedYTextFm(
      provider,
      '---\nname: my-skill\ndescription: A skill\nmetadata:\n  version: "1.0"\n  author: Inkeep\n  repository: github.com/inkeep/x\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-panel-yaml-error"');
    expect(html).toContain('data-key="name"');
    expect(html).toContain('data-key="description"');
    expect(html).toContain('data-key="metadata"');
  });

  test('nested object value renders ObjectWidget (not the text widget)', () => {
    const provider = makeProvider('nested-object-doc');
    seedYTextFm(
      provider,
      '---\nname: my-skill\nmetadata:\n  version: "1.0"\n  author: Inkeep\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="object-widget"');
    expect(html).toMatch(/data-key="metadata"[^>]*data-complex-value="true"/);
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="metadata"/);
    expect(html).not.toMatch(
      /data-testid="text-widget"[^>]*data-key="metadata"|data-key="metadata"[^>]*data-testid="text-widget"/,
    );
    expect(html).not.toMatch(/data-testid="complex-value-widget"[^>]*data-key="metadata"/);
    expect(html).toContain('version');
    expect(html).toContain('author');
  });

  test('sibling scalar keys around a nested value still render their interactive widgets', () => {
    const provider = makeProvider('nested-skill-siblings-doc');
    seedYTextFm(
      provider,
      '---\nname: my-skill\ndescription: A skill\nmetadata:\n  version: "1.0"\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="text-widget"');
    expect(html).toContain('data-key="name"');
    expect(html).toContain('data-key="description"');
    expect(html).toContain('aria-label="name type: Text. Click to change."');
    expect(html).toContain('aria-label="description type: Text. Click to change."');
  });

  test('nested row carries a static (non-dropdown) type icon — no coercion footgun', () => {
    const provider = makeProvider('nested-static-icon-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(
      /data-testid="type-icon-static"[^>]*data-key="metadata"[^>]*data-type="object"/,
    );
    expect(html).not.toMatch(/data-testid="type-icon-button"[^>]*data-key="metadata"/);
  });

  test('array-of-objects value renders as indexed ArrayOfObjectsWidget (not the read-only complex preview)', () => {
    const provider = makeProvider('array-of-objects-doc');
    seedYTextFm(
      provider,
      '---\nplugins:\n  - name: a\n    version: 1\n  - name: b\n    version: 2\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-panel-yaml-error"');
    expect(html).toMatch(
      /data-testid="array-of-objects-widget"[^>]*data-key="plugins"|data-key="plugins"[^>]*data-testid="array-of-objects-widget"/,
    );
    expect(html).toContain('2 items');
    expect(html).not.toMatch(/data-testid="complex-value-widget"[^>]*data-key="plugins"/);
  });

  test('nested row keeps the delete affordance — user can still remove the key', () => {
    const provider = makeProvider('nested-delete-doc');
    seedYTextFm(provider, '---\nname: x\nmetadata:\n  version: "1.0"\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('aria-label="Remove metadata"');
  });
});

describe('PropertyPanel ObjectWidget recursive rendering', () => {
  test('object value renders an expandable Collapsible with an accessible trigger', () => {
    const provider = makeProvider('object-widget-trigger-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n  author: Inkeep\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="object-widget-trigger"[^>]*data-key="metadata"/);
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="metadata"[^>]*aria-expanded="true"|data-key="metadata"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="true"/,
    );
    expect(html).toMatch(/aria-label="Collapse metadata"|aria-label="Expand metadata"/);
  });

  test('expanded object widget renders child rows for every nested key', () => {
    const provider = makeProvider('object-widget-children-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0"\n  author: Inkeep\n  repository: github.com/x\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="version"/);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="author"/);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="repository"/);
    expect(html).toMatch(/data-testid="object-widget-children"[^>]*data-key="metadata"/);
  });

  test('scalar leaves at depth 1 render via the existing scalar widgets per inferType', () => {
    const provider = makeProvider('object-widget-scalar-leaves-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n  count: 42\n  active: true\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="text-widget"[^>]*data-key="version"/);
    expect(html).toMatch(/data-testid="number-widget"[^>]*data-key="count"/);
    expect(html).toMatch(/data-testid="boolean-widget"[^>]*data-key="active"/);
  });

  test('nested object at depth 2 renders its own ObjectWidget recursively', () => {
    const provider = makeProvider('object-widget-recursive-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0"\n  details:\n    license: MIT\n    notes: hello\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="metadata"[^>]*data-depth="0"/);
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="details"[^>]*data-depth="1"/);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="details"/);
  });

  test('depth>=1 ObjectWidgets default to collapsed (avoid drowning the panel)', () => {
    const provider = makeProvider('object-widget-depth-default-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  details:\n    license: MIT\n    repo: github.com/x\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="metadata"[^>]*aria-expanded="true"|data-key="metadata"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="true"/,
    );
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="details"[^>]*aria-expanded="false"|data-key="details"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="false"/,
    );
  });

  test('nested scalar rows carry interactive type-icon-button (live picker) per leaf', () => {
    const provider = makeProvider('nested-icon-types-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n  count: 42\n  active: true\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(
      /data-testid="type-icon-button"[^>]*data-key="version"[^>]*data-type="text"/,
    );
    expect(html).toMatch(
      /data-testid="type-icon-button"[^>]*data-key="count"[^>]*data-type="number"/,
    );
    expect(html).toMatch(
      /data-testid="type-icon-button"[^>]*data-key="active"[^>]*data-type="boolean"/,
    );
  });

  test('empty object {} renders an ObjectWidget with no child rows', () => {
    const provider = makeProvider('empty-object-doc');
    seedYTextFm(provider, '---\nmetadata: {}\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="metadata"/);
    expect(html).toMatch(
      /data-testid="object-widget-children"[^>]*data-key="metadata"[^>]*><\/div>/,
    );
  });
});

describe('PropertyPanel error rendering', () => {
  test('rows render with no error subline by default', () => {
    const provider = makeProvider('no-error-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-error"');
    expect(html).not.toContain('data-error="');
  });

  test('row container exposes data-error="undefined" attribute slot for failed-commit attribution', () => {
    const provider = makeProvider('error-slot-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="property-row"');
    expect(html).toContain('data-key="title"');
  });
});
