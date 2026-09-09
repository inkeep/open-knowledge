import {
  AGENT_REGISTRY,
  type AgentId,
  type ApplyIntent,
  type ApplyReport,
  editorPathId,
  type HostSnapshot,
  type SatisfierId,
  type SurfaceState,
} from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ApplyAgentConnectionsResult } from '@/lib/agent-connections';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    i18n: { locale: 'en' },
    t: renderLinguiTemplate,
  }),
}));

const {
  ConfigureConnectionDialog,
  RemoveConnectionDialog,
  connectionsFromSnapshot,
  intentsForParts,
  removalIntents,
} = await import('./AgentConnectionDialogs');

const VISIBLE_AGENTS: AgentId[] = [
  'claude',
  'claude-desktop',
  'cursor',
  'codex',
  'copilot',
  'opencode',
  'antigravity',
];

const EMPTY_REPORT: ApplyReport = { actions: [], conflicts: [], withheld: [] };

function diskSatisfierIds(agentId: AgentId): SatisfierId[] {
  return AGENT_REGISTRY[agentId].satisfiers
    .filter((satisfier) => satisfier.scope !== 'session')
    .map((satisfier) => satisfier.id);
}

function satisfierId(
  agentId: AgentId,
  piece: 'mcp' | 'skill',
  scope: 'project' | 'user',
): SatisfierId {
  const id = AGENT_REGISTRY[agentId].satisfiers.find(
    (satisfier) => satisfier.piece === piece && satisfier.scope === scope,
  )?.id;
  if (id === undefined) throw new Error(`missing ${agentId}:${piece}:${scope}`);
  return id;
}

function snapshotWith(installed: readonly SatisfierId[] = []): HostSnapshot {
  const installedIds = new Set<string>(installed);
  const satisfiers = Object.fromEntries(
    Object.values(AGENT_REGISTRY).flatMap((agent) =>
      agent.satisfiers
        .filter((satisfier) => satisfier.probe.mode === 'probeable')
        .map((satisfier) => [
          satisfier.id,
          { state: installedIds.has(satisfier.id) ? 'satisfied' : 'absent' },
        ]),
    ),
  );
  return {
    probes: { env: 'desktop', satisfiers },
    detection: { detected: VISIBLE_AGENTS, probed: true },
  };
}

function withSurfaceStates(
  base: HostSnapshot,
  overrides: Readonly<Record<string, SurfaceState>>,
): HostSnapshot {
  return {
    ...base,
    probes: {
      ...base.probes,
      satisfiers: {
        ...base.probes.satisfiers,
        ...Object.fromEntries(Object.entries(overrides).map(([id, state]) => [id, { state }])),
      },
    },
  };
}

function result(snapshot: HostSnapshot, ok = true): ApplyAgentConnectionsResult {
  return { ok, report: EMPTY_REPORT, snapshot };
}

function OpenUntilClosed({
  render: renderDialog,
}: {
  render: (open: boolean, onOpenChange: (next: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return renderDialog(open, setOpen);
}

function tallyText(dialog: HTMLElement): string {
  return dialog.querySelector('[aria-live="polite"]')?.textContent ?? '';
}

async function renderConfigureDialog(
  applyConnections: (intents: readonly ApplyIntent[]) => Promise<ApplyAgentConnectionsResult>,
  agentId: AgentId,
  paired = false,
) {
  const read = await applyConnections([]);
  const connection =
    read.snapshot === null
      ? null
      : (connectionsFromSnapshot(read.snapshot).find((c) => c.id === agentId) ?? null);
  return render(
    <TooltipProvider>
      <OpenUntilClosed
        render={(open, onOpenChange) => (
          <ConfigureConnectionDialog
            connection={connection}
            open={open}
            onOpenChange={onOpenChange}
            paired={paired}
            onSave={async (parts, alsoRemove) =>
              applyConnections(
                connection === null ? [] : intentsForParts(connection, parts, alsoRemove),
              )
            }
          />
        )}
      />
    </TooltipProvider>,
  );
}

async function renderRemoveDialog(
  applyConnections: (intents: readonly ApplyIntent[]) => Promise<ApplyAgentConnectionsResult>,
  agentId: AgentId,
  paired = false,
) {
  const read = await applyConnections([]);
  const connection =
    read.snapshot === null
      ? null
      : (connectionsFromSnapshot(read.snapshot).find((c) => c.id === agentId) ?? null);
  return render(
    <TooltipProvider>
      <OpenUntilClosed
        render={(open, onOpenChange) => (
          <RemoveConnectionDialog
            connection={connection}
            open={open}
            onOpenChange={onOpenChange}
            paired={paired}
            onRemove={async (peers) =>
              applyConnections(connection === null ? [] : removalIntents(connection, peers))
            }
          />
        )}
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('a rejected write never seals the dialog', () => {
  test('a save that rejects surfaces the failure and leaves the dialog closable', async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async () => result(snapshotWith()));
    const read = await apply();
    const connection =
      read.snapshot === null
        ? null
        : (connectionsFromSnapshot(read.snapshot).find((c) => c.id === 'claude') ?? null);

    render(
      <TooltipProvider>
        <OpenUntilClosed
          render={(open, onOpenChange) => (
            <ConfigureConnectionDialog
              connection={connection}
              open={open}
              onOpenChange={onOpenChange}
              onSave={() => Promise.reject(new Error('bridge died'))}
              paired={false}
            />
          )}
        />
      </TooltipProvider>,
    );

    const box = await screen.findByRole('checkbox', { name: /project mcp server/i });
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /cancel/i }).hasAttribute('disabled')).toBe(false),
    );
  });
});

describe('AgentConnectionDialogs', () => {
  test('Add opens the four-part editor and selects every registry-backed Claude item', async () => {
    const apply = vi.fn(async () => result(snapshotWith()));

    await renderConfigureDialog(apply, 'claude');

    const dialog = screen.getByRole('dialog', { name: 'Claude' });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(4);
    for (const checkbox of within(dialog).getAllByRole('checkbox')) {
      expect(checkbox.getAttribute('data-state')).toBe('checked');
      expect((checkbox as HTMLButtonElement).disabled).toBe(false);
    }
    expect(within(dialog).getByText('4 added')).toBeTruthy();
  });

  test('Finish setup mirrors probed state and submits only the changed satisfier', async () => {
    const before = snapshotWith([
      satisfierId('cursor', 'mcp', 'user'),
      satisfierId('cursor', 'mcp', 'project'),
      satisfierId('cursor', 'skill', 'user'),
    ]);
    const projectSkillId = satisfierId('cursor', 'skill', 'project');
    const after = snapshotWith([...diskSatisfierIds('cursor')]);
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(intents.length === 0 ? before : after),
    );
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'cursor');

    const dialog = screen.getByRole('dialog', { name: 'Cursor' });
    expect(
      within(dialog)
        .getByRole('checkbox', { name: 'Global MCP server' })
        .getAttribute('data-state'),
    ).toBe('checked');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Project skill' }).getAttribute('data-state'),
    ).toBe('unchecked');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apply).toHaveBeenLastCalledWith([{ satisfierId: projectSkillId, desired: 'present' }]);
  });

  test('Remove submits the checked registry cells and re-renders the returned snapshot', async () => {
    const before = snapshotWith(diskSatisfierIds('cursor'));
    const after = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(intents.length === 0 ? before : after),
    );
    const user = userEvent.setup();

    await renderRemoveDialog(apply, 'cursor');

    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove OpenKnowledge from Cursor?',
    });
    expect(within(dialog).getByText('Project MCP server')).toBeTruthy();
    expect(within(dialog).getByText('OpenKnowledge discovery skill')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(apply).toHaveBeenLastCalledWith([
      { satisfierId: satisfierId('cursor', 'mcp', 'project'), desired: 'absent' },
      { satisfierId: satisfierId('cursor', 'skill', 'project'), desired: 'absent' },
      { satisfierId: satisfierId('cursor', 'mcp', 'user'), desired: 'absent' },
      { satisfierId: satisfierId('cursor', 'skill', 'user'), desired: 'absent' },
    ]);
  });

  test('keeps a failed mutation open and announces the failure', async () => {
    const before = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(before, intents.length === 0),
    );
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'claude');
    const dialog = screen.getByRole('dialog', { name: 'Claude' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Something went wrong. Please try again.',
    );
    expect(screen.getByRole('dialog', { name: 'Claude' })).toBeTruthy();
  });

  test('a part with an unmet prerequisite stays selectable', async () => {
    const snapshot = snapshotWith();
    const user = userEvent.setup();

    await renderConfigureDialog(async () => result(snapshot), 'copilot');
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));

    const skill = within(dialog).getByRole('checkbox', { name: 'Project skill' });
    expect(skill.hasAttribute('disabled')).toBe(false);
    expect(skill.getAttribute('data-state')).toBe('checked');
  });

  test('unchecking an entry another agent reads asks instead of failing', async () => {
    const claudeMcp = satisfierId('claude', 'mcp', 'project');
    const copilotMcp = satisfierId('copilot', 'mcp', 'project');
    const snapshot = snapshotWith([...diskSatisfierIds('claude'), copilotMcp]);
    const refused: ApplyAgentConnectionsResult = {
      ok: false,
      report: {
        actions: [],
        conflicts: [
          {
            kind: 'unresolved-shared-copy',
            satisfierIds: [claudeMcp, copilotMcp],
            agentIds: ['claude', 'copilot'],
          },
        ],
        withheld: [claudeMcp],
      },
      snapshot,
    };
    const batches: (readonly ApplyIntent[])[] = [];
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(snapshot);
      batches.push(intents);
      return batches.length === 1 ? refused : result(snapshot);
    });
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'claude');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByText(/shared with/)).toBeTruthy();
    expect(within(dialog).queryByText(/Something went wrong/)).toBeNull();

    expect(tallyText(dialog)).toBe('Removes it for Claude and GitHub Copilot. 1 removed');

    await user.click(within(dialog).getByRole('button', { name: 'Remove for both' }));
    expect(batches[1]?.some((i) => i.satisfierId === copilotMcp && i.desired === 'absent')).toBe(
      true,
    );
  });

  test('a refusal with no peer to widen onto does not promise a removal the button cannot do', async () => {
    const claudeMcp = satisfierId('claude', 'mcp', 'project');
    const snapshot = snapshotWith(diskSatisfierIds('claude'));
    const refused: ApplyAgentConnectionsResult = {
      ok: false,
      report: {
        actions: [],
        conflicts: [
          {
            kind: 'unresolved-shared-copy',
            satisfierIds: [claudeMcp],
            agentIds: ['claude', 'copilot'],
          },
        ],
        withheld: [claudeMcp],
      },
      snapshot,
    };
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      intents.length === 0 ? result(snapshot) : refused,
    );
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'claude');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await within(dialog).findByText(/shared with/);
    expect(tallyText(dialog)).not.toContain('Removes it for');
    expect(within(dialog).queryByRole('button', { name: 'Remove for both' })).toBeNull();
    expect(
      (within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('a blocked refusal on a full disconnect does not claim the disconnect will happen', async () => {
    const claudeMcp = satisfierId('claude', 'mcp', 'project');
    const snapshot = snapshotWith(diskSatisfierIds('claude'));
    const refused: ApplyAgentConnectionsResult = {
      ok: false,
      report: {
        actions: [],
        conflicts: [
          {
            kind: 'unresolved-shared-copy',
            satisfierIds: [claudeMcp],
            agentIds: ['claude', 'copilot'],
          },
        ],
        withheld: [claudeMcp],
      },
      snapshot,
    };
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      intents.length === 0 ? result(snapshot) : refused,
    );
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'claude');
    const dialog = await screen.findByRole('dialog');
    for (const name of [
      'Project MCP server',
      'Project skill',
      'Global MCP server',
      'OpenKnowledge discovery skill',
    ]) {
      await user.click(within(dialog).getByRole('checkbox', { name }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await within(dialog).findByText(/shared with/);
    expect(tallyText(dialog)).not.toContain('This disconnects');
    expect(tallyText(dialog)).toBe('4 removed');
  });

  test('a mixed draft refused on its removal still says what it would add', async () => {
    const claudeMcp = satisfierId('claude', 'mcp', 'project');
    const copilotMcp = satisfierId('copilot', 'mcp', 'project');
    const discovery = satisfierId('claude', 'skill', 'user');
    const snapshot = snapshotWith([
      ...diskSatisfierIds('claude').filter((id) => id !== discovery),
      copilotMcp,
    ]);
    const refused: ApplyAgentConnectionsResult = {
      ok: false,
      report: {
        actions: [],
        conflicts: [
          {
            kind: 'unresolved-shared-copy',
            satisfierIds: [claudeMcp, copilotMcp],
            agentIds: ['claude', 'copilot'],
          },
        ],
        withheld: [claudeMcp, discovery],
      },
      snapshot,
    };
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      intents.length === 0 ? result(snapshot) : refused,
    );
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'claude');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'OpenKnowledge discovery skill' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await within(dialog).findByText(/shared with/);
    expect(tallyText(dialog)).toBe('Removes it for Claude and GitHub Copilot. 1 added · 2 removed');
  });

  test('a draft that turns a row off counts it as a removal, not a change', async () => {
    const snapshot = snapshotWith(diskSatisfierIds('cursor'));
    const user = userEvent.setup();

    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));

    expect(tallyText(dialog)).toBe('1 removed');
    expect(
      within(dialog).getByRole('button', { name: 'Remove' }).getAttribute('data-variant'),
    ).toBe('destructive');
  });

  test('turning every row off reads as a disconnect, not a save', async () => {
    const snapshot = snapshotWith(diskSatisfierIds('cursor'));
    const user = userEvent.setup();

    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog');
    for (const name of [
      'Project MCP server',
      'Project skill',
      'Global MCP server',
      'OpenKnowledge discovery skill',
    ]) {
      await user.click(within(dialog).getByRole('checkbox', { name }));
    }

    expect(tallyText(dialog)).toBe('This disconnects Cursor from OpenKnowledge.');
    expect(
      within(dialog).getByRole('button', { name: 'Remove' }).getAttribute('data-variant'),
    ).toBe('destructive');
    expect(within(dialog).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  test('a draft that both adds and removes stays a save, and says both', async () => {
    const snapshot = snapshotWith(
      diskSatisfierIds('cursor').filter((id) => id !== satisfierId('cursor', 'skill', 'user')),
    );
    const user = userEvent.setup();

    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'OpenKnowledge discovery skill' }),
    );

    expect(tallyText(dialog)).toBe('1 added · 1 removed');
    expect(
      within(dialog).getByRole('button', { name: 'Save changes' }).getAttribute('data-variant'),
    ).toBe('destructive');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(dialog.textContent).not.toContain('This disconnects');
  });

  test('the paired note holds through every draft shape while the footer tracks them', async () => {
    const note = 'share one setup, so changes here apply to both';
    const snapshot = snapshotWith(diskSatisfierIds('claude'));
    const user = userEvent.setup();

    await renderConfigureDialog(async () => result(snapshot), 'claude', true);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(note);

    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    expect(dialog.textContent).toContain(note);
    expect(tallyText(dialog)).toBe('1 removed');
    expect(dialog.textContent).not.toContain('disconnects');

    for (const name of [
      'Project MCP server',
      'Global MCP server',
      'OpenKnowledge discovery skill',
    ]) {
      await user.click(within(dialog).getByRole('checkbox', { name }));
    }
    expect(dialog.textContent).toContain(note);
    expect(tallyText(dialog)).toBe('This disconnects Claude from OpenKnowledge.');
  });

  test('a draft that has fully landed disables the button rather than leaving it enabled beside an empty tally', async () => {
    const projectSkill = satisfierId('cursor', 'skill', 'project');
    const before = snapshotWith(diskSatisfierIds('cursor'));
    const after = snapshotWith(diskSatisfierIds('cursor').filter((id) => id !== projectSkill));
    const connectionFor = (snapshot: HostSnapshot) =>
      connectionsFromSnapshot(snapshot).find((c) => c.id === 'cursor') ?? null;
    const user = userEvent.setup();

    const view = render(
      <TooltipProvider>
        <ConfigureConnectionDialog
          connection={connectionFor(before)}
          open
          onOpenChange={() => {}}
          onSave={async () => result(after, false)}
        />
      </TooltipProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    expect(tallyText(dialog)).toBe('1 removed');

    view.rerender(
      <TooltipProvider>
        <ConfigureConnectionDialog
          connection={connectionFor(after)}
          open
          onOpenChange={() => {}}
          onSave={async () => result(after, false)}
        />
      </TooltipProvider>,
    );

    expect(tallyText(dialog)).toBe('');
    expect(
      (within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('a partly-applied batch does not turn the tally into a phantom addition', async () => {
    const projectMcp = satisfierId('cursor', 'mcp', 'project');
    const before = snapshotWith(diskSatisfierIds('cursor'));
    const after = snapshotWith(diskSatisfierIds('cursor').filter((id) => id !== projectMcp));
    const connectionFor = (snapshot: HostSnapshot) =>
      connectionsFromSnapshot(snapshot).find((c) => c.id === 'cursor') ?? null;
    const user = userEvent.setup();

    const view = render(
      <TooltipProvider>
        <ConfigureConnectionDialog
          connection={connectionFor(before)}
          open
          onOpenChange={() => {}}
          onSave={async () => result(after, false)}
        />
      </TooltipProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));
    expect(tallyText(dialog)).toBe('2 removed');

    view.rerender(
      <TooltipProvider>
        <ConfigureConnectionDialog
          connection={connectionFor(after)}
          open
          onOpenChange={() => {}}
          onSave={async () => result(after, false)}
        />
      </TooltipProvider>,
    );

    expect(tallyText(dialog)).toBe('1 removed');
    expect(within(dialog).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  test('each blocked reason says its own thing', async () => {
    const mcp = satisfierId('cursor', 'mcp', 'project');
    const user = userEvent.setup();
    const snapshot = withSurfaceStates(snapshotWith(), { [mcp]: 'structural-na' });
    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });

    await user.hover(within(dialog).getAllByRole('button', { name: 'More information' })[0]);
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/no file of this kind on this machine yet/i)).toBeDefined();
    expect(within(tooltip[0]).queryByText(/cannot be changed automatically/i)).toBeNull();
  });

  test('a warning row names its consequence as the checkbox own description', async () => {
    const mcp = satisfierId('cursor', 'mcp', 'project');
    const snapshot = withSurfaceStates(snapshotWith(), { [mcp]: 'foreign-replaceable' });
    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });

    const box = within(dialog).getByRole('checkbox', { name: 'Project MCP server' });
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(dialog.querySelector(`#${describedBy}`)?.textContent).toMatch(/replaces it/i);
  });

  test('the remove dialog prints a path, never the internal pathId key', async () => {
    const snapshot = snapshotWith(diskSatisfierIds('claude'));
    await renderRemoveDialog(async () => result(snapshot), 'claude');
    const dialog = await screen.findByRole('alertdialog');

    expect(dialog.textContent).toContain('.mcp.json');
    expect(dialog.textContent).not.toMatch(/editor-project-config:/);
    expect(dialog.textContent).not.toMatch(/editor-user-skill-root:/);
  });

  test('a shared skills folder says whose it also is, before the click', async () => {
    const discoverySkill = satisfierId('cursor', 'skill', 'user');
    const base = snapshotWith();
    const snapshot: HostSnapshot = {
      ...base,
      probes: {
        ...base.probes,
        satisfiers: {
          ...base.probes.satisfiers,
          [discoverySkill]: { state: 'absent', sharedWith: ['claude'] },
        },
      },
    };

    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });

    expect(within(dialog).getByText(/This folder is also/i).textContent).toMatch(/Claude/);
    expect(within(dialog).queryByText(/does the same for them/i)).toBeNull();
  });

  test('offers a hand-edited entry as a live but unticked overwrite', async () => {
    const projectMcp = satisfierId('claude', 'mcp', 'project');
    const snapshot = withSurfaceStates(snapshotWith(), { [projectMcp]: 'foreign-replaceable' });

    await renderConfigureDialog(async () => result(snapshot), 'claude');
    const dialog = await screen.findByRole('dialog');

    const box = within(dialog).getByRole('checkbox', { name: 'Project MCP server' });
    expect(box.hasAttribute('disabled')).toBe(false);
    expect(box.getAttribute('data-state')).toBe('unchecked');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Project skill' }).getAttribute('data-state'),
    ).toBe('checked');
  });

  test('explains when Cursor has no automatic discovery-skill installer', async () => {
    const discoverySkillId = satisfierId('cursor', 'skill', 'user');
    const before = snapshotWith(diskSatisfierIds('cursor').filter((id) => id !== discoverySkillId));
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [
            {
              satisfierId: discoverySkillId,
              agentId: 'cursor',
              piece: 'skill',
              scope: 'user',
              kind: 'skill-bundle-copy',
              desired: 'present',
              action: 'skipped-unsupported',
              errorId: 'no-writer',
            },
          ],
          conflicts: [],
          withheld: [],
        },
        snapshot: before,
      } satisfies ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();

    await renderConfigureDialog(apply, 'cursor');
    const dialog = screen.getByRole('dialog', { name: 'Cursor' });
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'OpenKnowledge discovery skill' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('OpenKnowledge discovery skill');
    expect(alert.textContent).toContain(
      'Discovery skills are managed for all AI tools together. Install this one from Settings → Skills Studio.',
    );
  });

  test('an informational state is marked at all, so it cannot read as a problem', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'present-consent-unknown',
    });
    const _user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    expect(within(dialog).queryByRole('button', { name: 'Why this needs attention' })).toBeNull();
  });

  test('a foreign entry is marked, and says whose it is', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'foreign',
    });
    const user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    const chip = within(dialog).getByRole('button', { name: 'Why this needs attention' });
    await user.hover(chip);
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/does not recognize this entry/i)).toBeDefined();
  });

  test('a row that needs attention carries ONE mark, not a warning beside an info button', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'foreign',
    });
    const _user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    const field = within(dialog).getByText('Global MCP server').closest('[data-slot="field"]');
    expect(field).not.toBeNull();
    const marks = within(field as HTMLElement).getAllByRole('button');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute('aria-label')).toBe('Why this needs attention');
  });

  test('an actionable warning also says what the part does; a blocked one does not repeat itself', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'drifted',
    });
    const user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    await user.hover(within(dialog).getByRole('button', { name: 'Why this needs attention' }));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/changed after OpenKnowledge wrote it/i)).toBeDefined();
    expect(within(tooltip[0]).getByText(/Adds a global OpenKnowledge MCP entry/i)).toBeDefined();
  });

  test('a blocked warning states its own reason once, not the generic line', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'foreign',
    });
    const user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    await user.hover(within(dialog).getByRole('button', { name: 'Why this needs attention' }));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/cannot safely replace it/i)).toBeDefined();
    expect(within(tooltip[0]).queryByText(/cannot be changed automatically/i)).toBeNull();
  });

  test('a drifted entry says that turning it on replaces what is there', async () => {
    const snapshot = withSurfaceStates(snapshotWith(), {
      [satisfierId('cursor', 'mcp', 'user')]: 'drifted',
    });
    const user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');

    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    const chip = within(dialog).getByRole('button', { name: 'Why this needs attention' });
    await user.hover(chip);
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/Turning it on replaces it/i)).toBeDefined();
  });

  test('offers to remove a shared file for both agents instead of a generic error', async () => {
    const copilotProjectMcp = satisfierId('copilot', 'mcp', 'project');
    const claudeProjectMcp = satisfierId('claude', 'mcp', 'project');
    const before = snapshotWith(diskSatisfierIds('copilot'));
    const after = snapshotWith();
    const sharedRefusal: ApplyAgentConnectionsResult = {
      ok: false,
      report: {
        actions: [],
        conflicts: [
          {
            kind: 'unresolved-shared-copy',
            satisfierIds: [copilotProjectMcp, claudeProjectMcp],
            agentIds: ['copilot', 'claude'],
            pathId: editorPathId('editor-project-config', 'claude'),
          },
        ],
        withheld: [copilotProjectMcp],
      },
      snapshot: before,
    };
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      const widened = intents.some((intent) => intent.satisfierId === claudeProjectMcp);
      return widened ? result(after) : sharedRefusal;
    });
    const user = userEvent.setup();

    await renderRemoveDialog(apply, 'copilot');

    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove OpenKnowledge from GitHub Copilot?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const choice = await within(dialog).findByRole('status');
    expect(choice.textContent).toContain('Claude');
    expect(choice.textContent).toContain('.mcp.json');
    expect(within(dialog).queryByText('Something went wrong. Please try again.')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Remove for both' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(apply).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ satisfierId: claudeProjectMcp, desired: 'absent' }]),
    );
  });

  test('names the shared choice even when the shared path has no display name', async () => {
    const copilotProjectMcp = satisfierId('copilot', 'mcp', 'project');
    const claudeProjectMcp = satisfierId('claude', 'mcp', 'project');
    const before = snapshotWith(diskSatisfierIds('copilot'));
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [],
          conflicts: [
            {
              kind: 'unresolved-shared-copy',
              satisfierIds: [copilotProjectMcp, claudeProjectMcp],
              agentIds: ['copilot', 'claude'],
              pathId: editorPathId('editor-user-config', 'claude'),
            },
          ],
          withheld: [copilotProjectMcp],
        },
        snapshot: before,
      } satisfies ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();

    await renderRemoveDialog(apply, 'copilot');
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const choice = await within(dialog).findByRole('status');
    expect(choice.textContent).toContain('Claude');
    expect(within(dialog).getByRole('button', { name: 'Remove for both' })).toBeTruthy();
    expect(within(dialog).queryByText('Something went wrong. Please try again.')).toBeNull();
  });

  test('a non-shared removal failure still shows the generic error and no widen option', async () => {
    const before = snapshotWith(diskSatisfierIds('cursor'));
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) =>
      result(before, intents.length === 0),
    );
    const user = userEvent.setup();

    await renderRemoveDialog(apply, 'cursor');
    const dialog = screen.getByRole('alertdialog', { name: 'Remove OpenKnowledge from Cursor?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Something went wrong. Please try again.',
    );
    expect(within(dialog).queryByRole('button', { name: 'Remove for both' })).toBeNull();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  test('removing a paired agent says the sibling row disconnects too', async () => {
    const before = snapshotWith(diskSatisfierIds('claude'));
    const apply = vi.fn(async () => result(before));

    await renderRemoveDialog(apply, 'claude', true);
    const dialog = screen.getByRole('alertdialog');

    expect(dialog.textContent).toContain('share one setup, so removing it disconnects both');
  });

  test('removing an agent with one row makes no claim about a sibling', async () => {
    const before = snapshotWith(diskSatisfierIds('cursor'));
    const apply = vi.fn(async () => result(before));

    await renderRemoveDialog(apply, 'cursor');
    const dialog = screen.getByRole('alertdialog');

    expect(dialog.textContent).not.toContain('share one setup');
  });

  test('an agent with no global MCP surface is not offered one', async () => {
    const apply = vi.fn(async () => result(snapshotWith()));

    await renderConfigureDialog(apply, 'pi');
    const dialog = await screen.findByRole('dialog', { name: 'Pi' });

    expect(within(dialog).queryByRole('checkbox', { name: 'Global MCP server' })).toBeNull();
    expect(within(dialog).getByText('This machine')).toBeTruthy();
    expect(
      within(dialog).getByRole('checkbox', { name: 'OpenKnowledge discovery skill' }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: 'Project MCP server' })).toBeTruthy();
  });

  test('the remove confirmation names the actual config file, not just the artifact', async () => {
    const withPath = snapshotWith([satisfierId('lm-studio', 'mcp', 'user')]);
    const probed = {
      ...withPath,
      probes: {
        ...withPath.probes,
        satisfiers: {
          ...withPath.probes.satisfiers,
          [satisfierId('lm-studio', 'mcp', 'user')]: {
            state: 'satisfied' as const,
            path: '~/.lmstudio/mcp.json',
          },
        },
      },
    };
    const apply = vi.fn(async () => result(probed));

    await renderRemoveDialog(apply, 'lm-studio');

    expect(await screen.findByText('~/.lmstudio/mcp.json')).toBeTruthy();
  });

  test('a group with nothing in it drops its heading rather than standing empty', async () => {
    const apply = vi.fn(async () => result(snapshotWith()));

    await renderConfigureDialog(apply, 'hermes');
    const dialog = await screen.findByRole('dialog', { name: 'Hermes' });

    expect(within(dialog).queryByText('This project')).toBeNull();
    expect(within(dialog).queryByText('Recommended')).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'Project MCP server' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'Project skill' })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: 'Global MCP server' })).toBeTruthy();
  });
});

describe('a failed save names its reason', () => {
  function applyFailingWith(
    before: HostSnapshot,
    failure: {
      satisfierId: SatisfierId;
      agentId: AgentId;
      piece: 'mcp' | 'skill';
      scope: 'project' | 'user';
      errorId: string;
    },
    extra: Partial<ApplyAgentConnectionsResult> = {},
  ) {
    return vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [
            {
              satisfierId: failure.satisfierId,
              agentId: failure.agentId,
              piece: failure.piece,
              scope: failure.scope,
              kind: failure.piece === 'mcp' ? 'config-entry' : 'skill-bundle-copy',
              desired: 'present',
              action: 'failed',
              errorId: failure.errorId,
            },
          ],
          conflicts: [],
          withheld: [],
        },
        snapshot: before,
        ...extra,
      } as unknown as ApplyAgentConnectionsResult;
    });
  }

  async function saveAndReadAlert(agentId: AgentId, apply: ReturnType<typeof applyFailingWith>) {
    const user = userEvent.setup();
    await renderConfigureDialog(apply, agentId);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    return (await within(dialog).findByRole('alert')).textContent ?? '';
  }

  test('a skill whose MCP prerequisite was not written says so, naming the part', async () => {
    const apply = applyFailingWith(snapshotWith(), {
      satisfierId: satisfierId('copilot', 'skill', 'project'),
      agentId: 'copilot',
      piece: 'skill',
      scope: 'project',
      errorId: 'dependency-failed',
    });
    const text = await saveAndReadAlert('copilot', apply);
    expect(text).toContain('Project skill');
    expect(text).toContain(
      'This could not be set up because the MCP server entry it needs was not written.',
    );
    expect(text).not.toContain('Something went wrong');
  });

  test('a config file the writer could not parse is reported as left alone', async () => {
    const apply = applyFailingWith(snapshotWith(), {
      satisfierId: satisfierId('claude', 'mcp', 'project'),
      agentId: 'claude',
      piece: 'mcp',
      scope: 'project',
      errorId: 'write-declined',
    });
    const text = await saveAndReadAlert('claude', apply);
    expect(text).toContain('Project MCP server');
    expect(text).toContain(
      'OpenKnowledge left this file alone because it could not parse it safely.',
    );
  });

  test('a config file the agent has not created yet says to open the agent first', async () => {
    const apply = applyFailingWith(snapshotWith(), {
      satisfierId: satisfierId('copilot', 'mcp', 'user'),
      agentId: 'copilot',
      piece: 'mcp',
      scope: 'user',
      errorId: 'surface-missing',
    });
    const text = await saveAndReadAlert('copilot', apply);
    expect(text).toContain('Global MCP server');
    expect(text).toContain('This agent has no file of this kind on this machine yet.');
  });

  test('a host that refuses to manage connections says so instead of "something went wrong"', async () => {
    const before = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        unavailable: true,
        error: 'Managing AI tool connections is unavailable in this build.',
        report: EMPTY_REPORT,
        snapshot: before,
      } satisfies ApplyAgentConnectionsResult;
    });
    const text = await saveAndReadAlert('claude', apply);
    expect(text).toContain('Managing agent connections is unavailable in this build.');
  });

  test('an unexplained failure still shows the host error text under the generic line', async () => {
    const before = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        error: 'EACCES: permission denied, open .mcp.json',
        report: EMPTY_REPORT,
        snapshot: before,
      } satisfies ApplyAgentConnectionsResult;
    });
    const text = await saveAndReadAlert('claude', apply);
    expect(text).toContain('Something went wrong. Please try again.');
    expect(text).toContain('EACCES: permission denied, open .mcp.json');
  });

  test('unticking an MCP entry a ticked skill depends on explains the pairing', async () => {
    const before = snapshotWith(diskSatisfierIds('claude'));
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [],
          conflicts: [
            {
              kind: 'prerequisite-removed',
              satisfierIds: [
                satisfierId('claude', 'mcp', 'project'),
                satisfierId('claude', 'skill', 'project'),
              ],
              agentIds: ['claude'],
            },
          ],
          withheld: [satisfierId('claude', 'mcp', 'project')],
        },
        snapshot: before,
      } as unknown as ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();
    await renderConfigureDialog(apply, 'claude');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const text = (await within(dialog).findByRole('alert')).textContent ?? '';
    expect(text).toContain(
      'Project skill needs Project MCP server. Turn both off, or keep both on.',
    );
  });

  test('a failed removal names its reason too', async () => {
    const before = snapshotWith(diskSatisfierIds('claude'));
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [
            {
              satisfierId: satisfierId('claude', 'mcp', 'user'),
              agentId: 'claude',
              piece: 'mcp',
              scope: 'user',
              kind: 'config-entry',
              desired: 'absent',
              action: 'failed',
              errorId: 'write-failed',
            },
          ],
          conflicts: [],
          withheld: [],
        },
        snapshot: before,
      } as unknown as ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();
    await renderRemoveDialog(apply, 'claude');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const text = (await within(dialog).findByRole('alert')).textContent ?? '';
    expect(text).toContain('Global MCP server');
    expect(text).toContain('Writing this file failed. Check the OpenKnowledge log for the reason.');
  });
});

describe('shared folders in the removal dialog', () => {
  function withSharedFolder(base: HostSnapshot, id: SatisfierId, peers: string[]): HostSnapshot {
    return {
      ...base,
      probes: {
        ...base.probes,
        satisfiers: {
          ...base.probes.satisfiers,
          [id]: { ...base.probes.satisfiers[id], sharedWith: peers },
        },
      },
    };
  }

  test('the removal dialog says whose folder a listed skill also is', async () => {
    const skillId = satisfierId('cursor', 'skill', 'project');
    const snapshot = withSharedFolder(snapshotWith(diskSatisfierIds('cursor')), skillId, [
      'claude',
    ]);
    await renderRemoveDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain("This folder is also Claude's.");
  });

  test('the configure checkbox is described by the shared-folder line', async () => {
    const skillId = satisfierId('cursor', 'skill', 'project');
    const snapshot = withSharedFolder(snapshotWith(diskSatisfierIds('cursor')), skillId, [
      'claude',
    ]);
    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });
    const box = within(dialog).getByRole('checkbox', { name: 'Project skill' });
    const ids = (box.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    const shared = ids
      .map((id) => document.getElementById(id))
      .find((el) => el?.textContent?.includes('This folder is also'));
    expect(shared?.textContent).toContain("This folder is also Claude's.");
  });

  test('a peer with no row of its own blocks the removal and points at Skills Studio', async () => {
    const skillId = satisfierId('cursor', 'skill', 'project');
    const before = withSharedFolder(snapshotWith(diskSatisfierIds('cursor')), skillId, [
      'lm-studio',
    ]);
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [],
          conflicts: [
            {
              kind: 'unresolved-shared-copy',
              satisfierIds: [skillId],
              agentIds: ['cursor', 'lm-studio'],
            },
          ],
          withheld: [skillId],
        },
        snapshot: before,
      } as unknown as ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();
    await renderRemoveDialog(apply, 'cursor');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const note = await within(dialog).findByRole('status');
    expect(note.textContent).toContain('shared with LM Studio');
    expect(note.textContent).toContain('Unlink the folder in Skills Studio first.');
    expect(within(dialog).queryByRole('button', { name: 'Remove for both' })).toBeNull();
    expect(
      (within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a prerequisite that cannot be added says why', () => {
  test('a config the agent has not created yet is not called unrecognized', async () => {
    const before = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [],
          conflicts: [
            {
              kind: 'prerequisite-unavailable',
              satisfierIds: [
                satisfierId('copilot', 'mcp', 'user'),
                satisfierId('copilot', 'skill', 'project'),
              ],
              agentIds: ['copilot'],
              blockedReason: 'structural-na',
            },
          ],
          withheld: [satisfierId('copilot', 'skill', 'project')],
        },
        snapshot: before,
      } as unknown as ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();
    await renderConfigureDialog(apply, 'copilot');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    const text = (await within(dialog).findByRole('alert')).textContent ?? '';
    expect(text).toContain(
      'Project skill needs Global MCP server, and this agent has no file of that kind on this machine yet.',
    );
    expect(text).not.toContain('does not recognize');
  });
});

describe('a save that fails twice names both reasons', () => {
  test('one line per failed part, each with its own reason', async () => {
    const before = snapshotWith();
    const apply = vi.fn(async (intents: readonly ApplyIntent[]) => {
      if (intents.length === 0) return result(before);
      return {
        ok: false,
        report: {
          actions: [
            {
              satisfierId: satisfierId('cursor', 'mcp', 'project'),
              agentId: 'cursor',
              piece: 'mcp',
              scope: 'project',
              kind: 'config-entry',
              desired: 'present',
              action: 'failed',
              errorId: 'write-failed',
            },
            {
              satisfierId: satisfierId('cursor', 'mcp', 'user'),
              agentId: 'cursor',
              piece: 'mcp',
              scope: 'user',
              kind: 'config-entry',
              desired: 'present',
              action: 'failed',
              errorId: 'surface-missing',
            },
          ],
          conflicts: [],
          withheld: [],
        },
        snapshot: before,
      } as unknown as ApplyAgentConnectionsResult;
    });
    const user = userEvent.setup();
    await renderConfigureDialog(apply, 'cursor');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    const text = (await within(dialog).findByRole('alert')).textContent ?? '';

    expect(text).toContain('Project MCP server');
    expect(text).toContain('Writing this file failed.');
    expect(text).toContain('Global MCP server');
    expect(text).toContain('This agent has no file of this kind on this machine yet.');
    expect(text).not.toContain('Something went wrong');
  });
});

describe('the save button says when it will replace something', () => {
  test('ticking a part that replaces a foreign entry relabels Save', async () => {
    const mcp = satisfierId('cursor', 'mcp', 'project');
    const snapshot = withSurfaceStates(snapshotWith(), { [mcp]: 'foreign-replaceable' });
    const user = userEvent.setup();
    await renderConfigureDialog(async () => result(snapshot), 'cursor');
    const dialog = await screen.findByRole('dialog', { name: 'Cursor' });

    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Project MCP server' }));

    expect(within(dialog).getByRole('button', { name: 'Replace and save' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});
