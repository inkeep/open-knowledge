import { EDITOR_LABELS, type GuidanceRef } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';

function labelOf(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return EDITOR_LABELS[id as keyof typeof EDITOR_LABELS] ?? id;
}

export function guidanceText(ref: GuidanceRef | undefined): string | null {
  if (ref === undefined) return null;
  const agent = labelOf(ref.params?.agent);
  if (agent === null) return null;
  switch (ref.id) {
    case 'guidance.mcp.user-config':
      return t({
        id: 'guidance.mcp.user-config',
        message: `Adds OpenKnowledge to ${agent}'s own MCP config, so every project on this machine is reachable.`,
      });
    case 'guidance.mcp.project-config':
      return t({
        id: 'guidance.mcp.project-config',
        message: `Adds OpenKnowledge to the MCP config ${agent} reads in this project, so it can read, search, and edit these documents.`,
      });
    case 'guidance.mcp.session-injection':
      return t({
        id: 'guidance.mcp.session-injection',
        message: `${agent} gets OpenKnowledge's tools each time OpenKnowledge launches it; nothing is written to its config.`,
      });
    case 'guidance.mcp.managed-file':
      return t({
        id: 'guidance.mcp.managed-file',
        message: `Writes a small bridge file ${agent} loads from this project to reach OpenKnowledge.`,
      });
    case 'guidance.skill.project':
      return t({
        id: 'guidance.skill.project',
        message: `Puts the OpenKnowledge skill in ${agent}'s skills folder for this project, so its edits stay attributed.`,
      });
    case 'guidance.skill.user':
      return t({
        id: 'guidance.skill.user',
        message: `Puts the OpenKnowledge discovery skill in ${agent}'s machine-wide skills folder, so it can find OpenKnowledge in any project.`,
      });
    case 'guidance.skill.central-store':
      return t({
        id: 'guidance.skill.central-store',
        message: `Puts the OpenKnowledge skill in the central skills store ${agent} reads.`,
      });
    default:
      return null;
  }
}

export function troubleshootingText(ref: GuidanceRef | undefined): string | null {
  if (ref === undefined) return null;
  const agent = labelOf(ref.params?.agent);
  if (agent === null) return null;
  switch (ref.id) {
    case 'troubleshooting.claude.project-entry-not-approved':
      return t({
        id: 'troubleshooting.claude.project-entry-not-approved',
        message: `If ${agent} shows no OpenKnowledge tools, run it in this project and approve the OpenKnowledge server once.`,
      });
    case 'troubleshooting.claude-desktop.per-tool-approval':
      return t({
        id: 'troubleshooting.claude-desktop.per-tool-approval',
        message: `${agent} asks you to approve each OpenKnowledge tool the first time it is used.`,
      });
    case 'troubleshooting.cursor.project-entry-not-loaded':
      return t({
        id: 'troubleshooting.cursor.project-entry-not-loaded',
        message: `If ${agent} shows no OpenKnowledge tools, open Customize → MCPs, pick open-knowledge and switch on its .cursor/mcp.json source; ${agent} leaves project servers off until you do.`,
      });
    case 'troubleshooting.codex.folder-trust':
      return t({
        id: 'troubleshooting.codex.folder-trust',
        message: `${agent} loads a project entry only in a folder you have trusted. The CLI asks on first run in a new folder, but codex exec cannot ask and older builds may not remember the answer, so if the tools do not appear, mark the project trusted in ~/.codex/config.toml. Trusting a project loads its whole .codex/ layer, including hooks and rules.`,
      });
    case 'troubleshooting.codex.desktop-project-config':
      if (ref.params?.honoredByDesktop === true) return null;
      return t({
        id: 'troubleshooting.codex.desktop-project-config',
        message: `The ${agent} desktop app ignores this project config; only the ${agent} CLI reads it.`,
      });
    case 'troubleshooting.copilot.shared-workspace-config': {
      const sourceAgent = labelOf(ref.params?.sourceAgent) ?? '';
      return t({
        id: 'troubleshooting.copilot.shared-workspace-config',
        message: `${agent} reads the workspace MCP config OpenKnowledge writes for ${sourceAgent}; removing it for one removes it for both. ${agent} loads it only after you confirm folder trust on first launch, and skips it silently in a folder you have not trusted, including under copilot -p, which cannot show the trust prompt.`,
      });
    }
    case 'troubleshooting.openclaw.central-store-missing':
      return t({
        id: 'troubleshooting.openclaw.central-store-missing',
        message: `${agent}'s central skills store does not exist yet; start ${agent} once so it creates it, then try again.`,
      });
    case 'troubleshooting.pi.folder-trust':
      return t({
        id: 'troubleshooting.pi.folder-trust',
        message: `${agent} loads project extensions only in folders you have trusted; trust this folder in ${agent} if the tools do not appear.`,
      });
    case 'troubleshooting.lm-studio.config-path-mismatch':
      return t({
        id: 'troubleshooting.lm-studio.config-path-mismatch',
        message: `If ${agent} shows no OpenKnowledge tools, check that its MCP config path in its settings matches the file OpenKnowledge wrote.`,
      });
    default:
      return null;
  }
}
