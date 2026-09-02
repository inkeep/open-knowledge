import type { FrontmatterType } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { type AddDraft, AddPropertyRow } from './FrontmatterRow';
import { DEFAULT_VALUE_FOR_TYPE } from './PropertyWidgets';

const TYPE_PICKER_LABEL: Record<FrontmatterType, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Checkbox',
  date: 'Date',
  list: 'List',
  object: 'Object',
};

const ALL_TYPE_PICKS = (
  Object.entries(TYPE_PICKER_LABEL) as Array<[FrontmatterType, string]>
).filter(([type]) => type !== 'object');

function PropertyPanelHarness({
  initialType = 'text' as FrontmatterType,
}: {
  initialType?: FrontmatterType;
}) {
  const [draft, setDraft] = useState<AddDraft>(() => ({
    name: '',
    type: initialType,
    value: initialType === 'boolean' ? false : '',
    error: null,
  }));
  return (
    <AddPropertyRow
      draft={draft}
      onChangeName={(name) => setDraft((p) => ({ ...p, name, error: null }))}
      onChangeType={(type) => {
        const defaultValue =
          type === 'date' ? new Date().toISOString().slice(0, 10) : DEFAULT_VALUE_FOR_TYPE[type];
        setDraft((p) => ({ ...p, type, value: defaultValue, error: null }));
      }}
      onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
      onCommit={() => {}}
      onCancel={() => {}}
    />
  );
}

function FolderDefaultsHarness({
  initialType = 'text' as FrontmatterType,
}: {
  initialType?: FrontmatterType;
}) {
  const [draft, setDraft] = useState<AddDraft>(() => ({
    name: '',
    type: initialType,
    value: initialType === 'boolean' ? false : '',
    error: null,
  }));
  return (
    <AddPropertyRow
      draft={draft}
      onChangeName={(name) => setDraft((p) => ({ ...p, name, error: null }))}
      onChangeType={(type) => {
        const defaultValue =
          type === 'date' ? new Date().toISOString().slice(0, 10) : DEFAULT_VALUE_FOR_TYPE[type];
        setDraft((p) => ({ ...p, type, value: defaultValue, error: null }));
      }}
      onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
      onCommit={() => {}}
      onCancel={() => {}}
    />
  );
}

describe('AddPropertyRow — typing target stays focused after type change (PropertyPanel consumer)', () => {
  afterEach(() => {
    cleanup();
  });

  test('autoFocus lands on the name input on first mount (sanity)', () => {
    render(<PropertyPanelHarness />);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('add-property-name-input');
  });

  test.each(
    ALL_TYPE_PICKS,
  )('after picking %s, the next keystrokes reach the name input', async (_type, label) => {
    const user = userEvent.setup();
    render(<PropertyPanelHarness />);
    await user.click(screen.getByTestId('type-icon-button'));
    await user.click(await screen.findByText(label));

    await user.keyboard('prop_name');

    const nameInput = screen.getByTestId('add-property-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('prop_name');
  });

  test('focus stays on name input — and partial typing is preserved — when type is changed after partial name entry', async () => {
    const user = userEvent.setup();
    render(<PropertyPanelHarness />);
    await user.keyboard('my_prop');
    await user.click(screen.getByTestId('type-icon-button'));
    await user.click(await screen.findByText('Number'));

    const nameInput = screen.getByTestId('add-property-name-input') as HTMLInputElement;
    expect(document.activeElement?.getAttribute('data-testid')).toBe('add-property-name-input');
    expect(nameInput.value).toBe('my_prop');
  });
});

describe('AddPropertyRow — typing target stays focused after type change (FolderPropertiesCard consumer)', () => {
  afterEach(() => {
    cleanup();
  });

  test.each(
    ALL_TYPE_PICKS,
  )('after picking %s, the next keystrokes reach the name input', async (_type, label) => {
    const user = userEvent.setup();
    render(<FolderDefaultsHarness />);
    await user.click(screen.getByTestId('type-icon-button'));
    await user.click(await screen.findByText(label));

    await user.keyboard('prop_name');

    const nameInput = screen.getByTestId('add-property-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('prop_name');
  });
});

describe('AddPropertyRow — value-channel ADD gates on non-empty name AND value', () => {
  afterEach(() => {
    cleanup();
  });

  test('disabled with empty name and empty text value (initial mount)', () => {
    render(<PropertyPanelHarness />);
    const btn = screen.getByTestId('add-property-commit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test('still disabled after typing a name when value is empty (text type)', async () => {
    const user = userEvent.setup();
    render(<PropertyPanelHarness />);
    await user.keyboard('my_prop');
    const btn = screen.getByTestId('add-property-commit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test('enabled when value is `false` (boolean) — false is a valid stored value', () => {
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'my_flag',
        type: 'boolean',
        value: false,
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={() => {}}
          onCancel={() => {}}
        />
      );
    }
    render(<Harness />);
    const btn = screen.getByTestId('add-property-commit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  test('enabled when value is `0` (number) — 0 is a valid stored value', () => {
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'my_count',
        type: 'number',
        value: 0,
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={() => {}}
          onCancel={() => {}}
        />
      );
    }
    render(<Harness />);
    const btn = screen.getByTestId('add-property-commit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  test('Enter in the VALUE field commits the property (text) — no mouse needed', async () => {
    const commits: Array<string | number | boolean | null | undefined> = [];
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'status',
        type: 'text',
        value: '',
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={(valueOverride) => {
            commits.push(valueOverride as string);
          }}
          onCancel={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const valueInput = screen.getByTestId('text-widget') as HTMLTextAreaElement;
    await user.click(valueInput);
    await user.keyboard('active{Enter}');
    expect(commits).toEqual(['active']);
  });

  test('Enter in the VALUE field commits the property (number) with the typed value', async () => {
    const commits: Array<string | number | boolean | null | undefined> = [];
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'count',
        type: 'number',
        value: 0,
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={(valueOverride) => {
            commits.push(valueOverride as number);
          }}
          onCancel={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const valueInput = screen.getByTestId('number-widget') as HTMLInputElement;
    await user.click(valueInput);
    await user.clear(valueInput);
    await user.keyboard('42{Enter}');
    expect(commits).toEqual([42]);
  });

  test('Enter in the VALUE field commits the property (date) with a valid parsed date', async () => {
    const commits: Array<string | number | boolean | null | undefined> = [];
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'due',
        type: 'date',
        value: '2026-01-15',
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={(valueOverride) => {
            commits.push(valueOverride as string);
          }}
          onCancel={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const dateInput = screen.getByTestId('date-widget').querySelector('input');
    if (!dateInput) throw new Error('date input not found');
    await user.click(dateInput);
    await user.clear(dateInput);
    await user.keyboard('Jan 20, 2026{Enter}');
    expect(commits).toEqual(['2026-01-20']);
  });

  test('Enter in the VALUE field with an INVALID date does not commit (no silent onSubmit(undefined))', async () => {
    const commits: Array<string | number | boolean | null | undefined> = [];
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: 'due',
        type: 'date',
        value: '2026-01-15',
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={(valueOverride) => {
            commits.push(valueOverride as string);
          }}
          onCancel={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const dateInput = screen.getByTestId('date-widget').querySelector('input');
    if (!dateInput) throw new Error('date input not found');
    await user.click(dateInput);
    await user.clear(dateInput);
    await user.keyboard('not-a-date{Enter}');
    expect(commits).toEqual([]);
  });

  test('Enter-key path bypasses the button gate — consumer must hold the line', async () => {
    const commitCalls: number[] = [];
    function Harness() {
      const [draft, setDraft] = useState<AddDraft>({
        name: '',
        type: 'text',
        value: '',
        error: null,
      });
      return (
        <AddPropertyRow
          draft={draft}
          onChangeName={(name) => setDraft((p) => ({ ...p, name }))}
          onChangeType={() => {}}
          onChangeValue={(value) => setDraft((p) => ({ ...p, value }))}
          onCommit={() => {
            commitCalls.push(Date.now());
          }}
          onCancel={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard('my_prop');
    expect((screen.getByTestId('add-property-commit') as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(commitCalls.length).toBe(1);
  });
});
