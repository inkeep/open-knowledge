import {
  AGENT_REGISTRY,
  EDITOR_LABELS,
  GUIDANCE_KEYS,
  guidanceId,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { followupHintText } from '@/lib/agent-followup-hint';
import { guidanceText, troubleshootingText } from '@/lib/agent-guidance-copy';

const registryRefs = Object.values(AGENT_REGISTRY).flatMap((agent) =>
  agent.satisfiers.flatMap((satisfier) =>
    [satisfier.guidance, satisfier.followup, ...satisfier.troubleshooting].filter(
      (ref) => ref !== undefined,
    ),
  ),
);

describe('guidance and troubleshooting copy', () => {
  test('every guidance and troubleshooting ref the registry declares resolves to copy naming its agent', () => {
    const declared = registryRefs.filter((ref) => !ref.id.startsWith('followup.'));
    expect(declared.length).toBeGreaterThan(0);
    for (const ref of declared) {
      const text = ref.id.startsWith('guidance.') ? guidanceText(ref) : troubleshootingText(ref);
      expect(text, ref.id).not.toBeNull();
      const agent = String(ref.params?.agent);
      expect(text, ref.id).toContain(EDITOR_LABELS[agent as keyof typeof EDITOR_LABELS] ?? agent);
    }
  });

  test('every manifest key has a resolver, split by namespace', () => {
    for (const key of GUIDANCE_KEYS) {
      const ref = {
        id: guidanceId(key),
        params: { agent: 'codex', sourceAgent: 'claude', honoredByDesktop: false },
      };
      const text = key.startsWith('followup.')
        ? followupHintText(ref)
        : key.startsWith('guidance.')
          ? guidanceText(ref)
          : troubleshootingText(ref);
      expect(text, key).not.toBeNull();
    }
  });

  test("Codex's desktop note speaks only while the desktop app ignores the project config", () => {
    const base = { id: guidanceId('troubleshooting.codex.desktop-project-config') };
    expect(
      troubleshootingText({ ...base, params: { agent: 'codex', honoredByDesktop: false } }),
    ).toBe('The Codex desktop app ignores this project config; only the Codex CLI reads it.');
    expect(
      troubleshootingText({ ...base, params: { agent: 'codex', honoredByDesktop: true } }),
    ).toBeNull();
  });

  test("Codex's folder-trust note names the run that cannot ask and the whole layer trust loads", () => {
    const text = troubleshootingText({
      id: guidanceId('troubleshooting.codex.folder-trust'),
      params: { agent: 'codex' },
    });
    expect(text).toContain('codex exec');
    expect(text).toContain('hooks and rules');
    expect(text).toContain('~/.codex/config.toml');
  });

  test("Copilot's note names folder trust and the mode that cannot prompt", () => {
    const text = troubleshootingText({
      id: guidanceId('troubleshooting.copilot.shared-workspace-config'),
      params: { agent: 'copilot', sourceAgent: 'claude' },
    });
    expect(text).toContain('confirm folder trust');
    expect(text).toContain('copilot -p');
  });

  test("Cursor's note names the server as Cursor lists it and where to switch it on", () => {
    const text = troubleshootingText({
      id: guidanceId('troubleshooting.cursor.project-entry-not-loaded'),
      params: { agent: 'cursor' },
    });
    expect(text).toContain('pick open-knowledge');
    expect(text).toContain('Customize → MCPs');
  });

  test('a ref without an agent or with an unknown id renders nothing', () => {
    expect(guidanceText(undefined)).toBeNull();
    expect(guidanceText({ id: guidanceId('guidance.mcp.user-config') })).toBeNull();
    expect(
      troubleshootingText({
        id: guidanceId('troubleshooting.unwritten'),
        params: { agent: 'claude' },
      }),
    ).toBeNull();
  });
});
