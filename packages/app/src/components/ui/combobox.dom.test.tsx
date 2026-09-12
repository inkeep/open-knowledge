import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from './combobox';

const LANGUAGES = ['English', 'Vietnamese'];

function ChipsHarness() {
  const anchor = useComboboxAnchor();
  const [selected, setSelected] = useState(['English']);
  return (
    <Combobox multiple items={LANGUAGES} value={selected} onValueChange={setSelected}>
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {selected.map((language) => (
            <ComboboxChip key={language} removeLabel={`Remove ${language}`}>
              {language}
            </ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput aria-label="Languages" />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No languages found.</ComboboxEmpty>
        <ComboboxList>
          {(language: string) => (
            <ComboboxItem key={language} value={language}>
              {language}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

afterEach(() => cleanup());

describe('Combobox chips', () => {
  test('popup carries reduced-motion opt-in at runtime', async () => {
    render(<ChipsHarness />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Languages' }));
    await screen.findByRole('listbox');
    const popup = document.querySelector('[data-slot="combobox-content"]');
    expect(popup?.hasAttribute('data-open')).toBe(true);
    expectVisualClassTokens(popup?.getAttribute('class') ?? '', [
      'motion-reduce:data-open:animate-none',
      'motion-reduce:data-closed:animate-none',
      'motion-reduce:duration-0',
    ]);
  });

  test('selecting and removing chips updates the selected options', async () => {
    render(<ChipsHarness />);
    const input = screen.getByRole('combobox', { name: 'Languages' });
    await userEvent.click(input);
    await userEvent.click(await screen.findByRole('option', { name: 'Vietnamese' }));
    const remove = await screen.findByRole('button', { name: 'Remove Vietnamese' });
    expect(screen.getByRole('option', { name: 'Vietnamese' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.click(remove);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Vietnamese' })).toBeNull(),
    );
    expect(screen.getByRole('option', { name: 'English' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: 'Vietnamese' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });
});
