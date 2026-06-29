import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { TagDialogBody } from './TagDialog.tsx';

describe('TagDialogBody', () => {
  test('loading state renders a placeholder paragraph', () => {
    const html = renderToString(
      <TagDialogBody fetchState={{ kind: 'loading' }} tag="proj" onSelectDoc={() => {}} />,
    );
    expect(html).toContain('tag-dialog-loading');
    expect(html).toContain('Loading');
  });

  test('idle state renders a placeholder (mirrors loading)', () => {
    const html = renderToString(
      <TagDialogBody fetchState={{ kind: 'idle' }} tag="proj" onSelectDoc={() => {}} />,
    );
    expect(html).toContain('tag-dialog-loading');
  });

  test('error state surfaces the message', () => {
    const html = renderToString(
      <TagDialogBody
        fetchState={{ kind: 'error', message: 'Server error: 503' }}
        tag="proj"
        onSelectDoc={() => {}}
      />,
    );
    expect(html).toContain('tag-dialog-error');
    expect(html).toContain('Server error: 503');
  });

  test('empty docs list shows the singleton-doc explanation', () => {
    const html = renderToString(
      <TagDialogBody
        fetchState={{ kind: 'ready', docs: [] }}
        tag="solitary"
        onSelectDoc={() => {}}
      />,
    );
    expect(html).toContain('tag-dialog-empty');
    expect(html).toContain('solitary');
    expect(html).toContain('Only the current document');
  });

  test('renders a row per doc, with title + (when distinct) docName subtext', () => {
    const html = renderToString(
      <TagDialogBody
        fetchState={{
          kind: 'ready',
          docs: [
            { docName: 'alpha', title: 'Alpha title', snippet: null },
            { docName: 'beta', title: 'beta', snippet: null },
          ],
        }}
        tag="proj"
        onSelectDoc={() => {}}
      />,
    );
    expect(html).toContain('Alpha title');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    const rowMatches = html.match(/data-testid="tag-dialog-row"/g);
    expect(rowMatches).not.toBeNull();
    expect(rowMatches?.length).toBe(2);
  });
});
