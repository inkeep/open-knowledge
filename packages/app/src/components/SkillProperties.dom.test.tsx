
import { describe, expect, mock, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import * as linguiShim from '../../tests/lingui-macro-shim';

mock.module('@lingui/react/macro', () => linguiShim);

const { SkillProperties } = await import('./SkillProperties');
const { PropertyProvider } = await import('./PropertyContext');

/** SkillProperties reuses the document PropertyPanel, which reads the shared
 *  property-panel context — the same `PropertyProvider` EditorArea mounts. */
function renderPanel(ui: Parameters<typeof render>[0]) {
  return render(<PropertyProvider>{ui}</PropertyProvider>);
}

function makeProvider(source: string): { provider: HocuspocusProvider; ytext: Y.Text } {
  const document = new Y.Doc();
  const ytext = document.getText('source');
  ytext.insert(0, source);
  const provider = {
    document,
    configuration: { name: '__skill__/project/foo' },
    on: () => {},
    off: () => {},
  } as unknown as HocuspocusProvider;
  return { provider, ytext };
}

const SOURCE = '---\nname: foo\ndescription: initial desc\n---\n\n# Body\n';

describe('SkillProperties (CRDT)', () => {
  test('renders the reused document property panel with the doc frontmatter', () => {
    const { provider } = makeProvider(SOURCE);
    renderPanel(<SkillProperties provider={provider} name="foo" onRename={() => {}} />);
    expect(screen.getByTestId('property-panel')).toBeTruthy();
    expect(screen.getByDisplayValue('initial desc')).toBeTruthy();
  });

  test('committing a changed name fires onRename (a git-mv rename), not a patch', () => {
    const { provider, ytext } = makeProvider(SOURCE);
    const onRename = mock((_next: string) => {});
    renderPanel(<SkillProperties provider={provider} name="foo" onRename={onRename} />);
    const nameInput = screen.getByTestId('skill-name-input');
    fireEvent.change(nameInput, { target: { value: 'bar' } });
    fireEvent.blur(nameInput);
    expect(onRename).toHaveBeenCalledWith('bar');
    expect(ytext.toString()).toContain('name: foo');
  });

  test('an unchanged name does not fire onRename', () => {
    const { provider } = makeProvider(SOURCE);
    const onRename = mock((_next: string) => {});
    renderPanel(<SkillProperties provider={provider} name="foo" onRename={onRename} />);
    const nameInput = screen.getByTestId('skill-name-input');
    fireEvent.blur(nameInput);
    expect(onRename).not.toHaveBeenCalled();
  });
});
