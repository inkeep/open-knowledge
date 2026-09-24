import { bindConfigDoc, type ConfigBinding } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { EnterpriseHostsSection } from './EnterpriseHostsSection';

let doc: Y.Doc;
let binding: ConfigBinding;

function bindUserConfig(initialYaml = ''): ConfigBinding {
  doc = new Y.Doc();
  if (initialYaml !== '') doc.getText('source').insert(0, initialYaml);
  const syncedListeners = new Set<() => void>();
  const bound = bindConfigDoc(
    {
      document: doc,
      on: (_event, listener) => syncedListeners.add(listener),
      off: (_event, listener) => syncedListeners.delete(listener),
    },
    'user',
  );
  for (const listener of syncedListeners) listener();
  return bound;
}

function source(): string {
  return doc.getText('source').toString();
}

function renderSection() {
  return render(<EnterpriseHostsSection binding={binding} />);
}

describe('EnterpriseHostsSection', () => {
  beforeEach(() => {
    binding = bindUserConfig();
  });

  afterEach(() => {
    cleanup();
    binding.dispose();
  });

  test('shows an empty state when no host is declared', () => {
    renderSection();
    expect(screen.getByTestId('settings-enterprise-hosts-empty')).toBeTruthy();
  });

  test('keeps the add button disabled until a host is typed', async () => {
    const user = userEvent.setup();
    renderSection();
    const add = screen.getByRole('button', { name: 'Add host' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.type(screen.getByLabelText('Add a host'), '   ');
    expect(add.disabled).toBe(true);
    await user.type(screen.getByLabelText('Add a host'), 'ghes.example.com');
    expect(add.disabled).toBe(false);
  });

  test('adding a host writes a normalized github declaration to the user config', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(
      screen.getByLabelText('Add a host'),
      'https://GHES.Example.com:8443/team/kb.git',
    );
    await user.click(screen.getByRole('button', { name: 'Add host' }));

    expect(binding.current().git.hosts['ghes.example.com']?.provider).toBe('github');
    expect(source()).toContain('ghes.example.com');
    const list = screen.getByTestId('settings-enterprise-hosts-list');
    expect(within(list).getByText('ghes.example.com')).toBeTruthy();
    expect((screen.getByLabelText('Add a host') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toContain('Restart OpenKnowledge');
  });

  test('removing a host deletes only that declaration', async () => {
    binding.dispose();
    binding = bindUserConfig(
      'git:\n  hosts:\n    a.example.com:\n      provider: github\n    b.example.com:\n      provider: github\n',
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Remove a.example.com' }));

    expect(binding.current().git.hosts['a.example.com']).toBeUndefined();
    expect(binding.current().git.hosts['b.example.com']?.provider).toBe('github');
    expect(screen.queryByText('a.example.com')).toBeNull();
    expect(screen.getByText('b.example.com')).toBeTruthy();
  });

  test('removing a host moves focus to the next remaining remove button', async () => {
    binding.dispose();
    binding = bindUserConfig(
      'git:\n  hosts:\n    a.example.com:\n      provider: github\n    b.example.com:\n      provider: github\n    c.example.com:\n      provider: github\n',
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Remove b.example.com' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove c.example.com' }),
    );
    await user.click(screen.getByRole('button', { name: 'Remove c.example.com' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove a.example.com' }),
    );
  });

  test('removing the last host moves focus to the add field', async () => {
    binding.dispose();
    binding = bindUserConfig('git:\n  hosts:\n    a.example.com:\n      provider: github\n');
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Remove a.example.com' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Add a host'));
  });

  test.each([
    ['github.com', 'always recognized'],
    ['not a host', "isn't a valid hostname"],
  ])('refuses %j without writing and explains why', async (input, message) => {
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText('Add a host'), input);
    await user.click(screen.getByRole('button', { name: 'Add host' }));

    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(screen.getByLabelText('Add a host').getAttribute('aria-invalid')).toBe('true');
    expect(source()).toBe('');
  });

  test('refuses a host that is already declared', async () => {
    binding.dispose();
    binding = bindUserConfig('git:\n  hosts:\n    ghes.example.com:\n      provider: github\n');
    const before = source();
    const user = userEvent.setup();
    renderSection();
    await user.type(screen.getByLabelText('Add a host'), 'GHES.example.com');
    await user.click(screen.getByRole('button', { name: 'Add host' }));

    expect(screen.getByRole('alert').textContent).toContain('already in the list');
    expect(source()).toBe(before);
  });

  test('reflects declarations written elsewhere', async () => {
    renderSection();
    binding.patch({ git: { hosts: { 'remote.example.com': { provider: 'github' } } } });
    expect(await screen.findByText('remote.example.com')).toBeTruthy();
  });
});
