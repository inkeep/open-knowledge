import { describe, expect, test } from 'vitest';
import { foldEditorsByPrimary } from './editor-list-fold';

type Editor = {
  id: string;
  state: 'installed' | 'not-installed';
  detected: boolean;
};

describe('foldEditorsByPrimary', () => {
  test('orders primary editors first without changing order within either group', () => {
    const editors: Editor[] = [
      { id: 'secondary-a', state: 'not-installed', detected: false },
      { id: 'wired', state: 'installed', detected: false },
      { id: 'secondary-b', state: 'not-installed', detected: false },
      { id: 'detected', state: 'not-installed', detected: true },
    ];

    const { shownEditors, hiddenCount } = foldEditorsByPrimary(editors, true);

    expect(shownEditors.map((editor) => editor.id)).toEqual([
      'wired',
      'detected',
      'secondary-a',
      'secondary-b',
    ]);
    expect(hiddenCount).toBe(2);
  });
});
