/**
 * RTL tests for the CRDT-bound template Properties panel. Asserts the behaviors
 * unique to it: `title` + `description` round-trip through the live
 * `bindFrontmatterDoc` binding (an edit IS a CRDT mutation of the template's
 * YAML region), and the `name` field commits a RENAME (never a plain frontmatter
 * patch). Uses a real-Y.Doc fake provider — same pattern `SourceEditor` uses.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import * as linguiShim from '../../tests/lingui-macro-shim';

mock.module('@lingui/react/macro', () => linguiShim);

const { TemplateProperties } = await import('./TemplateProperties');

function makeProvider(source: string): { provider: HocuspocusProvider; ytext: Y.Text } {
  const document = new Y.Doc();
  const ytext = document.getText('source');
  ytext.insert(0, source);
  const provider = {
    document,
    configuration: { name: '__template__/notes/meeting' },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
  return { provider, ytext };
}

const SOURCE = '---\ntitle: Meeting\ndescription: initial desc\n---\n\n# Agenda\n';

describe('TemplateProperties (CRDT)', () => {
  test('seeds title + description from the doc frontmatter', () => {
    const { provider } = makeProvider(SOURCE);
    render(<TemplateProperties provider={provider} name="meeting" folder="notes" />);
    expect((screen.getByTestId('template-title-input') as HTMLInputElement).value).toBe('Meeting');
    expect((screen.getByTestId('template-description-input') as HTMLTextAreaElement).value).toBe(
      'initial desc',
    );
  });

  test('editing the title patches the YAML region of Y.Text (CRDT)', () => {
    const { provider, ytext } = makeProvider(SOURCE);
    render(<TemplateProperties provider={provider} name="meeting" folder="notes" />);
    const title = screen.getByTestId('template-title-input');
    fireEvent.change(title, { target: { value: 'Standup' } });
    fireEvent.blur(title);
    expect(ytext.toString()).toContain('title: Standup');
    expect(ytext.toString()).toContain('# Agenda');
  });

  test('committing a changed name fires onRename (a git-mv rename), not a patch', () => {
    const { provider, ytext } = makeProvider(SOURCE);
    const onRename = mock((_next: string) => {});
    render(
      <TemplateProperties provider={provider} name="meeting" folder="notes" onRename={onRename} />,
    );
    const nameInput = screen.getByTestId('template-name-input');
    fireEvent.change(nameInput, { target: { value: 'standup' } });
    fireEvent.blur(nameInput);
    expect(onRename).toHaveBeenCalledWith('standup');
    // The body/frontmatter is NOT rewritten by the panel — the rename spine owns the file.
    expect(ytext.toString()).toContain('# Agenda');
  });
});
