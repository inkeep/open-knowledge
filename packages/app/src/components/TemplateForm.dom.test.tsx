/**
 * DOM tests for the template form — the filename-slug derivation helper and
 * the Name -> derived-filename behavior. Runs under jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  composeDocBody,
  parseDocBody,
  slugifyTemplateName,
  TemplateFormFields,
  useTemplateForm,
} from './TemplateForm';

const RESEARCH_BODY = `---\ntype: research-note\nstatus: provisional\nsources: []\ncreated: {{date}}\ntags: [research, provisional]\n---\n\n## Question\n`;

describe('parseDocBody / composeDocBody', () => {
  test('splits type, property rows, and markdown', () => {
    const parsed = parseDocBody(RESEARCH_BODY);
    expect(parsed.type).toBe('research-note');
    expect(parsed.markdown).toContain('## Question');
    expect(parsed.markdown).not.toContain('status:'); // frontmatter lifted out
    const byKey = Object.fromEntries(parsed.properties.map((p) => [p.key, p.value]));
    expect(byKey.status).toBe('provisional');
    expect(byKey.sources).toBe('[]'); // value shape preserved verbatim
    expect(byKey.created).toBe('{{date}}'); // token preserved
    expect(byKey.tags).toBe('[research, provisional]');
    // `type` is NOT duplicated into the rows.
    expect(parsed.properties.some((p) => p.key === 'type')).toBe(false);
  });

  test('round-trips parse -> compose with type first and tokens intact', () => {
    const parsed = parseDocBody(RESEARCH_BODY);
    const composed = composeDocBody({
      type: parsed.type,
      properties: parsed.properties,
      markdown: parsed.markdown,
    });
    expect(composed).toContain('created: {{date}}');
    expect(composed.indexOf('type: research-note')).toBeLessThan(composed.indexOf('status:'));
    expect(composed).toContain('## Question');
    // stable: re-parsing yields the same logical model.
    const reparsed = parseDocBody(composed);
    expect(reparsed.type).toBe('research-note');
    expect(reparsed.properties.map((p) => p.key)).toEqual(['status', 'sources', 'created', 'tags']);
  });

  test('no type and no rows → markdown only (no empty frontmatter block)', () => {
    expect(composeDocBody({ type: '', properties: [], markdown: '## Body\n' })).toBe('## Body\n');
  });

  test('empty-key rows are dropped on compose', () => {
    const composed = composeDocBody({
      type: 'note',
      properties: [{ id: 'a', key: '', value: 'ignored' }],
      markdown: '# B',
    });
    expect(composed).toContain('type: note');
    expect(composed).not.toContain('ignored');
  });

  test('plain markdown template parses to empty doc-frontmatter', () => {
    const parsed = parseDocBody('# Just markdown\n');
    expect(parsed.type).toBe('');
    expect(parsed.properties).toEqual([]);
    expect(parsed.markdown).toBe('# Just markdown\n');
  });
});

describe('slugifyTemplateName', () => {
  test('lowercases and hyphenates a human name', () => {
    expect(slugifyTemplateName('Blog post')).toBe('blog-post');
  });

  test('collapses runs of punctuation and whitespace to one hyphen', () => {
    expect(slugifyTemplateName('Weekly  1:1   notes')).toBe('weekly-1-1-notes');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugifyTemplateName('  Draft!  ')).toBe('draft');
  });

  test('leaves an already-valid slug unchanged', () => {
    expect(slugifyTemplateName('blog-post')).toBe('blog-post');
  });

  test('returns empty when the name has no alphanumeric content', () => {
    expect(slugifyTemplateName('!!!')).toBe('');
  });
});

function CreateFormHarness() {
  const form = useTemplateForm({
    mode: 'create',
    folderPath: '',
    initial: { name: '', title: '', description: '', body: '' },
    existingNames: new Set(),
    onCommitted: () => {},
  });
  return <TemplateFormFields form={form} />;
}

describe('TemplateFormFields — create mode', () => {
  afterEach(() => {
    cleanup();
  });

  test('derives the filename from the name as the user types', async () => {
    const user = userEvent.setup();
    render(<CreateFormHarness />);
    await user.type(screen.getByTestId('template-name-input'), 'My Release Notes');
    expect(screen.getByText('my-release-notes.md')).toBeDefined();
  });

  test('shows the required-name error only after the field is blurred empty', async () => {
    const user = userEvent.setup();
    render(<CreateFormHarness />);
    expect(screen.queryByText('Enter a title for this template.')).toBeNull();
    await user.click(screen.getByTestId('template-name-input'));
    await user.tab();
    expect(screen.getByText('Enter a title for this template.')).toBeDefined();
  });
});

test('composeDocBody drops a property row also named `type` (no duplicate key)', () => {
  const composed = composeDocBody({
    type: 'research-note',
    properties: [{ id: 'a', key: 'type', value: 'should-be-dropped' }],
    markdown: '# B',
  });
  expect((composed.match(/type:/g) ?? []).length).toBe(1);
  expect(composed).toContain('type: research-note');
  expect(composed).not.toContain('should-be-dropped');
});

function EditFormHarness({ body }: { body: string }) {
  const form = useTemplateForm({
    mode: 'edit',
    folderPath: 'notes',
    scope: 'local',
    initial: { name: 'tpl', title: 'T', description: '', body },
    onCommitted: () => {},
  });
  return <TemplateFormFields form={form} />;
}

describe('TemplateDefaultProperties — interactions', () => {
  afterEach(() => {
    cleanup();
  });

  test('seeds one row per existing doc-frontmatter property', () => {
    render(<EditFormHarness body={'---\nstatus: provisional\ntags: [a]\n---\n\n# B'} />);
    const keyInputs = screen.getAllByLabelText('Property name') as HTMLInputElement[];
    expect(keyInputs.map((i) => i.value).sort()).toEqual(['status', 'tags']);
  });

  test('Add property appends an empty row', async () => {
    const user = userEvent.setup();
    render(<CreateFormHarness />);
    expect(screen.queryAllByLabelText('Property name')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Add property' }));
    expect(screen.getAllByLabelText('Property name')).toHaveLength(1);
  });

  test('Remove property deletes its row', async () => {
    const user = userEvent.setup();
    render(<EditFormHarness body={'---\nstatus: provisional\n---\n\n# B'} />);
    expect(screen.getAllByLabelText('Property name')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove property' }));
    expect(screen.queryAllByLabelText('Property name')).toHaveLength(0);
  });

  test('typing into a property value updates the input', async () => {
    const user = userEvent.setup();
    render(<EditFormHarness body={'---\nstatus: provisional\n---\n\n# B'} />);
    const valueInput = screen.getByLabelText('Property value') as HTMLInputElement;
    await user.clear(valueInput);
    await user.type(valueInput, 'done');
    expect(valueInput.value).toBe('done');
  });
});
