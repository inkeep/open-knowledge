/**
 * Regression tests for AddPropertyRow's add-property focus invariant.
 *
 * Invariant: after the user picks a type from the type-icon DropdownMenu,
 * focus must land on the name <input>, not the dropdown trigger <button>,
 * so the next keystrokes reach the name field — regardless of which type
 * is picked or the order in which the user types the name and picks the
 * type. Radix's default close-auto-focus returns focus to the trigger;
 * AddPropertyRow's onCloseAutoFocus handler redirects it to the name input.
 *
 * Both consumers duplicate the same add-property reducer (`beginAdd` /
 * `changeAddType`): PropertyPanel (file frontmatter) and FolderPropertiesCard
 * (folder cascade). Two harnesses exercise each consumer's reducer so a
 * per-consumer fix that diverges between callers is caught.
 *
 * Exercises `render` + `userEvent` under the jsdom substrate; invocation via
 * `bun run test:dom` from `packages/app/`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { FrontmatterType } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { type AddDraft, AddPropertyRow } from './FrontmatterRow';
import { DEFAULT_VALUE_FOR_TYPE } from './PropertyWidgets';

// Type → dropdown label. `Record<FrontmatterType, string>` makes the set
// exhaustive at compile time: adding a frontmatter type forces a picker
// label here, so the focus invariant is pinned for every type — the
// post-pick value widget differs per type (DateWidget/ListWidget render
// their own inputs), so a type-agnostic claim must be checked per type.
//
// The picker dropdown excludes 'object' (the nested editor lands later);
// the label is kept here for exhaustiveness and `ALL_TYPE_PICKS` filters
// it out so the focus assertion only iterates types the user can actually
// pick.
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

/** Mirrors PropertyPanel's add-property reducer (`beginAdd` / `changeAddType`). */
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

/**
 * Mirrors FolderPropertiesCard's add-property reducer (`beginAdd` /
 * `changeAddType`). Byte-identical to PropertyPanelHarness today; the
 * second harness keeps per-consumer coverage explicit so a fix that
 * diverges between callers stays caught.
 */
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
    // Comparing the active element's testid (rather than the input node
    // itself) sidesteps Bun's diff dumper serializing the entire jsdom
    // graph when toBe(domNode) fails. Same observable signal, no 800MB
    // failure output. https://github.com/oven-sh/bun/issues/22689 family.
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
    // The docblock invariant claims order-agnosticism: the "type-first → name" flow
    // is exercised above; this pins the reverse "name-first → type-pick" flow so a
    // future refactor that resets the input on type change would surface here.
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

// Value-channel ADD button is gated on non-empty name AND non-empty
// value (matches server's mergePatch drop-on-empty semantic). Covers
// both click and Enter-key paths — the Enter handler bypasses the
// button's disabled state, so the consumer's commitAdd must hold the
// line independently.
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
    // Typing a value then pressing Enter must commit the new
    // property, not just blur the value editor. The committed value is
    // forwarded synchronously to onCommit so the consumer doesn't race the
    // async draft state update.
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
    // DateWidget's Enter path is the most complex of the three scalars: it
    // forwards to onSubmit only when commitInput() returns a parsed ISO date.
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
    // The invalid-parse guard in DateWidget's Enter handler is the sole
    // mechanism preventing onSubmit(undefined) from reaching commitAdd.
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
    // The button's `disabled` attribute blocks click-driven commits.
    // The Enter handler on the name input calls onCommit unconditionally,
    // so the consumer's commitAdd is the defense-in-depth gate. This
    // test pins that onCommit fires on Enter even when the button is
    // disabled — the consumer is responsible for rejecting the empty
    // value (see FolderPropertiesCard.commitAdd / PropertyPanel.commitAdd).
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
    await user.keyboard('my_prop'); // name only, no value
    expect((screen.getByTestId('add-property-commit') as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(commitCalls.length).toBe(1);
  });
});
