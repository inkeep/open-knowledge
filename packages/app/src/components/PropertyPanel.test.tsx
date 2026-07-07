import { afterEach, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PropertyProvider } from './PropertyContext';
import { PropertyPanel } from './PropertyPanel';

// Renders PropertyPanel inside PropertyProvider — the panel reads
// `useProperties()` for the cross-tree add-property signal and would throw
// "must be used within <PropertyProvider />" without this wrapper.
//
// TooltipProvider wraps the tree because PropertyWidgets' `ListWidget`
// surface wraps invalid-tag chips in `<Tooltip>` (carrying the grammar-
// hint copy). Production has a root-level TooltipProvider so the
// component renders fine; the test substrate needs to opt in.
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
      // ignore
    }
  }
});

/**
 * Seed the FM region of `Y.Text('source')` directly. The YAML
 * region IS the FM source of truth; the panel reads through `bindFrontmatterDoc`
 * which observes Y.Text.
 */
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
    // Empty-YAML / single-other-key docs surface the placeholder so the
    // user discovers tags exists without us writing an empty `tags: []`
    // to disk on every fresh doc.
    const provider = makeProvider('tags-absent-doc');
    seedYTextFm(provider, '---\ntitle: Hello\n---\n');
    const html = renderPanel(provider);
    // Static identity column shows the placeholder testids (no live
    // TypeIconButton, no rename KeyNameButton).
    expect(html).toContain('data-testid="property-placeholder-name"');
    expect(html).toContain('data-testid="property-placeholder-icon"');
    expect(html).toContain('data-key="tags"');
    // No live affordances for the placeholder row.
    const placeholderName = html.match(
      /data-testid="property-placeholder-name"[^>]*data-key="tags"/,
    );
    expect(placeholderName).not.toBeNull();
  });

  test('does NOT render the placeholder when `tags: []` is in YAML (explicit empty)', () => {
    // `tags: []` is a real YAML key — render it through the regular row
    // plumbing at its source-order position, never as a placeholder. The
    // user picked an explicit empty array; they don't want a duplicate
    // discoverability affordance pinned at the end.
    const provider = makeProvider('tags-empty-array-doc');
    seedYTextFm(provider, '---\ntags: []\n---\n');
    const html = renderPanel(provider);
    expect(html).not.toContain('data-testid="property-placeholder-name"');
    // Real list row for tags surfaces instead.
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
    // Pin the muted styling — distinguishes the row visually from a real
    // property without dropping affordances the user might still want to
    // tab into.
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
    // Label is "Add" (no "property" suffix); the `>Add<` boundary pins the
    // exact span content and rejects the historical "Add property" shape
    // appearing as visible label text. The `aria-label="Add property"`
    // attribute (accessible name) IS allowed and intentional — it
    // restores the action's object for screen-reader users so they don't
    // hear a context-free "Add, button". So the negative assertion targets
    // the visible-text shape specifically: ">Add property<" appearing
    // inside any tag (the historical label slot).
    expect(html).toContain('>Add<');
    expect(html).not.toMatch(/>Add property</);
    // The trigger Button MUST NOT carry `pl-7` anymore — the previous
    // padding-left approach made the Button's hover background span the
    // full row width (20px too wide on the left). The current scheme uses
    // a sibling `<span aria-hidden className="h-7 w-4 shrink-0" />` spacer
    // to reserve the drag-handle column, then `gap-1` + `px-2` on the
    // Button lands the `+` icon center at the TypeIcon column edge.
    const triggerTagMatch = html.match(/<[^>]*data-testid="add-property-trigger"[^>]*>/);
    expect(triggerTagMatch).not.toBeNull();
    expect(triggerTagMatch?.[0]).not.toContain('pl-7');
    expect(triggerTagMatch?.[0]).toContain('px-2');
    // The aria-hidden drag-handle spacer must precede the trigger Button
    // in the rendered HTML so it lands in DOM order LEFT of the Button.
    const spacerIdx = html.search(/<span\s+aria-hidden[^>]*class="h-7 w-4 shrink-0"/);
    const triggerIdx = html.indexOf('data-testid="add-property-trigger"');
    expect(spacerIdx).toBeGreaterThan(-1);
    expect(spacerIdx).toBeLessThan(triggerIdx);
  });

  test('the add-property trigger carries `aria-label="Add property"` for screen readers', () => {
    // Visible label is shortened to "Add"; the aria-label restores
    // the action's object so assistive tech announces "Add property,
    // button" instead of the context-free "Add, button". Pin so a
    // refactor that drops the attribute regresses screen-reader UX.
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
    // yaml@2 with `uniqueKeys: false` admits duplicate keys; both are
    // emitted by Document.toString and parsed via readFmKeys.
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
    // Array-coercion bug: `tags: [travel, spain, 2026]`
    // with an unquoted integer is well-formed YAML 1.2 — the panel must
    // render the row + all three pills, NOT the malformed-YAML banner.
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
    // A SKILL.md-like file with a
    // nested `metadata:` map. Today the read path returns
    // a populated map; this test pins that the panel renders all three
    // top-level keys — including the nested one — and the malformed
    // banner stays hidden because the YAML is well-formed.
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
    // The metadata row container carries the complex-value flag so the
    // panel chrome can style it accordingly.
    expect(html).toMatch(/data-key="metadata"[^>]*data-complex-value="true"/);
    // ObjectWidget is scoped to the metadata key.
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="metadata"/);
    // No text-widget for the metadata key — that scalar fallthrough would
    // have rendered `[object Object]` via `String(value)`.
    expect(html).not.toMatch(
      /data-testid="text-widget"[^>]*data-key="metadata"|data-key="metadata"[^>]*data-testid="text-widget"/,
    );
    // Object-row is not a ComplexValueWidget — that placeholder is reserved
    // for array-of-objects.
    expect(html).not.toMatch(/data-testid="complex-value-widget"[^>]*data-key="metadata"/);
    // Children render so the user can navigate the nested structure.
    expect(html).toContain('version');
    expect(html).toContain('author');
  });

  test('sibling scalar keys around a nested value still render their interactive widgets', () => {
    // Valid scalar rows (name, description) remain
    // visible and editable alongside the nested row. The scalar siblings
    // must keep their normal type-icon picker + scalar widget.
    const provider = makeProvider('nested-skill-siblings-doc');
    seedYTextFm(
      provider,
      '---\nname: my-skill\ndescription: A skill\nmetadata:\n  version: "1.0"\n---\n',
    );
    const html = renderPanel(provider);
    expect(html).toContain('data-testid="text-widget"');
    expect(html).toContain('data-key="name"');
    expect(html).toContain('data-key="description"');
    // Both scalar keys carry the interactive type-picker.
    expect(html).toContain('aria-label="name type: Text. Click to change."');
    expect(html).toContain('aria-label="description type: Text. Click to change."');
  });

  test('nested row carries a static (non-dropdown) type icon — no coercion footgun', () => {
    // The type-picker dropdown coerces via `coerceValue(value, target)`,
    // which `String()`s objects to '[object Object]' and would corrupt
    // the YAML on commit. The complex row swaps the picker for a static
    // glyph; the static icon reflects the inferred type ('object' here).
    const provider = makeProvider('nested-static-icon-doc');
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(
      /data-testid="type-icon-static"[^>]*data-key="metadata"[^>]*data-type="object"/,
    );
    // No live picker on the metadata row — the only row in this doc is
    // `metadata`, so a global negative is exhaustive here.
    expect(html).not.toMatch(/data-testid="type-icon-button"[^>]*data-key="metadata"/);
  });

  test('array-of-objects value renders as indexed ArrayOfObjectsWidget (not the read-only complex preview)', () => {
    // Arrays whose elements are objects route to the indexed-item editor
    // — every item is a plain object so each can render as its own nested
    // ObjectWidget. ComplexValueWidget is reserved for shapes the indexed
    // editor cannot represent (heterogeneous arrays).
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
    // The trigger summary reflects item count, not the read-only preview.
    expect(html).toContain('2 items');
    // No read-only complex preview for this row.
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
    // Top-level depth-0 object expands by default — the trigger reports
    // its open state via aria-expanded so screen readers track it.
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="metadata"[^>]*aria-expanded="true"|data-key="metadata"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="true"/,
    );
    // Accessible name on the expand control — required for keyboard +
    // screen-reader navigation.
    expect(html).toMatch(/aria-label="Collapse metadata"|aria-label="Expand metadata"/);
  });

  test('expanded object widget renders child rows for every nested key', () => {
    const provider = makeProvider('object-widget-children-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0"\n  author: Inkeep\n  repository: github.com/x\n---\n',
    );
    const html = renderPanel(provider);
    // Each child key gets a full FrontmatterRow inside the object-widget-
    // children container. Children are full rows so they carry the same
    // CRUD affordances (type picker, rename, delete) as top-level rows —
    // path-addressed through the binding's local API.
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="version"/);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="author"/);
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="repository"/);
    // The children container's data-key pins the parent map.
    expect(html).toMatch(/data-testid="object-widget-children"[^>]*data-key="metadata"/);
  });

  test('scalar leaves at depth 1 render via the existing scalar widgets per inferType', () => {
    const provider = makeProvider('object-widget-scalar-leaves-doc');
    // version is text, count is number, active is boolean — every existing
    // scalar widget is exercised under the same nested parent.
    seedYTextFm(provider, '---\nmetadata:\n  version: "1.0"\n  count: 42\n  active: true\n---\n');
    const html = renderPanel(provider);
    expect(html).toMatch(/data-testid="text-widget"[^>]*data-key="version"/);
    expect(html).toMatch(/data-testid="number-widget"[^>]*data-key="count"/);
    expect(html).toMatch(/data-testid="boolean-widget"[^>]*data-key="active"/);
  });

  test('nested object at depth 2 renders its own ObjectWidget recursively', () => {
    // A map-in-a-map exercises the recursion: the inner `details` value is
    // itself an object, so it must dispatch back into ObjectWidget — but at
    // depth 1, where it defaults collapsed (depth-0 is the only level that
    // auto-expands).
    const provider = makeProvider('object-widget-recursive-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  version: "1.0"\n  details:\n    license: MIT\n    notes: hello\n---\n',
    );
    const html = renderPanel(provider);
    // Outer object widget (depth 0) is expanded by default.
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="metadata"[^>]*data-depth="0"/);
    // Inner object widget (depth 1) is rendered inside, also as an ObjectWidget.
    expect(html).toMatch(/data-testid="object-widget"[^>]*data-key="details"[^>]*data-depth="1"/);
    // The row that owns `details` (inside metadata's object-widget-children)
    // is a complex-value FrontmatterRow.
    expect(html).toMatch(/data-testid="property-row"[^>]*data-key="details"/);
  });

  test('depth>=1 ObjectWidgets default to collapsed (avoid drowning the panel)', () => {
    // The depth-0 metadata widget auto-expands; the depth-1 details widget
    // does NOT. This keeps deep trees from auto-exploding on open.
    const provider = makeProvider('object-widget-depth-default-doc');
    seedYTextFm(
      provider,
      '---\nmetadata:\n  details:\n    license: MIT\n    repo: github.com/x\n---\n',
    );
    const html = renderPanel(provider);
    // Depth-0 trigger reports aria-expanded=true (auto-expanded).
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="metadata"[^>]*aria-expanded="true"|data-key="metadata"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="true"/,
    );
    // Depth-1 trigger reports aria-expanded=false (auto-collapsed).
    expect(html).toMatch(
      /data-testid="object-widget-trigger"[^>]*data-key="details"[^>]*aria-expanded="false"|data-key="details"[^>]*data-testid="object-widget-trigger"[^>]*aria-expanded="false"/,
    );
  });

  test('nested scalar rows carry interactive type-icon-button (live picker) per leaf', () => {
    // Nested scalar leaves are full FrontmatterRows with the
    // interactive type-picker dropdown — the user can change a nested scalar's
    // type just like a top-level scalar (coerceValue handles scalar↔scalar).
    // The static-icon path is reserved for COMPLEX values (nested object,
    // array of objects) where coercion would corrupt the structure.
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
    // The children container exists but is empty — no property-row inside it.
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
