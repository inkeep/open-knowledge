import { EDITOR_SETUP_DOC_SLUG, type EditorId } from '../constants/editors.ts';
import type { HandoffTarget } from '../handoff/types.ts';
import type { GuidanceKey } from './guidance.ts';
import {
  type AcpHarnessCliId,
  type AgentId,
  type AgentMode,
  guidanceId,
  type IntegrationPiece,
  type SatisfierId,
  type SatisfierScope,
  satisfierId,
} from './ids.ts';
import { CENTRAL_SKILL_STORE_PATH_ID, editorPathId } from './paths.ts';
import type {
  AcpFacet,
  AgentRecord,
  Attestation,
  EvidenceRef,
  ExternalFacet,
  GuidanceRef,
  Installability,
  ModeRecord,
  NOT_INSTALLABLE_REASONS,
  ProbeDeclaration,
  RequirementRecord,
  SatisfierRecord,
  UNPROBEABLE_REASONS,
  VERIFIED_POSTURES,
  VerifiedAgainst,
} from './schema.ts';
import type { ConsentClass, ProbeStrictness, SatisfierKind } from './vocabulary.ts';

type SatisfierInput = Omit<
  SatisfierRecord,
  'id' | 'sharedWith' | 'prerequisites' | 'consentClass' | 'installability' | 'preferred'
> & {
  sharedWith?: AgentId[];
  prerequisites?: SatisfierId[];
  consentClass?: ConsentClass;
  installability?: Installability;
  preferred?: boolean;
};

function defineSatisfier(input: SatisfierInput): SatisfierRecord {
  const { sharedWith, prerequisites, consentClass, installability, preferred, ...rest } = input;
  return {
    ...rest,
    id: satisfierId({
      agent: input.agent,
      piece: input.piece,
      scope: input.scope,
      kind: input.kind,
    }),
    sharedWith: sharedWith ?? [],
    prerequisites: prerequisites ?? [],
    consentClass: consentClass ?? 'none',
    installability: installability ?? 'installable',
    preferred: preferred ?? false,
  };
}

type AgentInput = Omit<
  AgentRecord,
  'offerOnlyWhenDetected' | 'offersConnectionRow' | 'detectionSources' | 'modes'
> & {
  offerOnlyWhenDetected?: boolean;
  offersConnectionRow?: boolean;
  detectionSources?: string[];
  modes: Partial<Record<AgentMode, { requirements: RequirementRecord[]; caveats?: GuidanceRef[] }>>;
};

function defineAgent(input: AgentInput): AgentRecord {
  const {
    offerOnlyWhenDetected,
    offersConnectionRow,
    detectionSources,
    modes: modeInputs,
    ...rest
  } = input;
  const modes: Partial<Record<AgentMode, ModeRecord>> = {};
  for (const [mode, value] of Object.entries(modeInputs) as [
    AgentMode,
    { requirements: RequirementRecord[]; caveats?: GuidanceRef[] },
  ][]) {
    modes[mode] = { requirements: value.requirements, caveats: value.caveats ?? [] };
  }
  return {
    ...rest,
    offerOnlyWhenDetected: offerOnlyWhenDetected ?? false,
    offersConnectionRow: offersConnectionRow ?? false,
    detectionSources: detectionSources ?? [],
    modes,
  };
}

const sid = (
  agent: AgentId,
  piece: IntegrationPiece,
  scope: SatisfierScope,
  kind: SatisfierKind,
): SatisfierId => satisfierId({ agent, piece, scope, kind });

const mcpRequirement = (satisfiedByAny: SatisfierId[]): RequirementRecord => ({
  piece: 'mcp',
  level: 'required',
  satisfiedByAny,
});

const skillRequirement = (satisfiedByAny: SatisfierId[]): RequirementRecord => ({
  piece: 'skill',
  level: 'recommended',
  satisfiedByAny,
});

const probeable = (...strictness: ProbeStrictness[]): ProbeDeclaration => ({
  mode: 'probeable',
  strictness,
});

const unprobeable = (
  reason: (typeof UNPROBEABLE_REASONS)[number],
  note?: string,
): ProbeDeclaration => ({ mode: 'unprobeable', reason, ...(note === undefined ? {} : { note }) });

const guide = (
  id: GuidanceKey,
  params?: Record<string, string | number | boolean>,
): GuidanceRef => ({
  id: guidanceId(id),
  ...(params === undefined ? {} : { params }),
});

const followupFor = (consentClass: ConsentClass, agent: AgentId): GuidanceRef | undefined =>
  consentClass === 'none' ? undefined : guide(`followup.${consentClass}`, { agent });

const read = (ref: string, note?: string): EvidenceRef => ({
  kind: 'source-read',
  ref,
  ...(note === undefined ? {} : { note }),
});

const attestVerified = (evidence: EvidenceRef[], verifiedAgainst?: VerifiedAgainst): Attestation =>
  verifiedAgainst === undefined
    ? { confidence: 'verified', evidence }
    : { confidence: 'verified', evidence, verifiedAgainst };

const attestContested = (
  evidence: EvidenceRef[],
  verifiedAgainst: VerifiedAgainst,
): Attestation => ({ confidence: 'contested', evidence, verifiedAgainst });

function acpFacet(input: {
  acpAgentId: string;
  featuredOrder: number | null;
  harnessCli: AcpHarnessCliId | null;
  readsEditorConfig: EditorId | null;
  readsEditorConfigAttestation: Attestation;
  verifiedPosture: (typeof VERIFIED_POSTURES)[number] | null;
}): AcpFacet {
  return {
    acpAgentId: input.acpAgentId,
    featuredOrder: input.featuredOrder,
    harnessCli: input.harnessCli,
    harnessReadsEditorConfig: input.readsEditorConfig,
    harnessReadsEditorConfigAttestation: input.readsEditorConfigAttestation,
    verifiedPosture: input.verifiedPosture,
  };
}

function externalFacet(input: {
  targetId: HandoffTarget;
  knownOrder: number;
  visible: boolean;
  displayName: string;
  appBrandName?: string;
  schemes: string[];
  installUrl: string;
  tagline?: string;
}): ExternalFacet {
  const { appBrandName, tagline, ...rest } = input;
  return {
    ...rest,
    ...(appBrandName === undefined ? {} : { appBrandName }),
    ...(tagline === undefined ? {} : { tagline }),
  };
}

const observed = (ref: string, note: string): EvidenceRef => ({ kind: 'observation', ref, note });

const CATALOG_PIN = { observedAt: '2026-07-02' } as const;

const CODE = {
  cliEditors: 'packages/cli/src/commands/editors.ts',
  coreEditors: 'packages/core/src/constants/editors.ts',
  acpRegistry: 'packages/server/src/acp/registry.ts',
  threadManager: 'packages/server/src/acp/thread-manager.ts',
  writeProjectSkill: 'packages/cli/src/integrations/write-project-skill.ts',
  repairSkills: 'packages/cli/src/commands/repair-skills.ts',
  skillInstall: 'packages/server/src/skill-install.ts',
  presenceProbes: 'packages/desktop/src/main/integrations-settings.ts',
} as const;

type EntryStrictness = ProbeStrictness[];

function userMcpEntry(input: {
  agent: EditorId;
  strictness: EntryStrictness;
  attestation: Attestation;
  installability?: Installability;
  notInstallableReason?: (typeof NOT_INSTALLABLE_REASONS)[number];
  troubleshooting?: GuidanceRef;
}): SatisfierRecord {
  return defineSatisfier({
    agent: input.agent,
    piece: 'mcp',
    scope: 'user',
    kind: 'config-entry',
    pathId: editorPathId('editor-user-config', input.agent),
    probe: probeable(...input.strictness),
    attestation: input.attestation,
    audience: 'this-user',
    installability: input.installability,
    notInstallableReason: input.notInstallableReason,
    guidance: guide('guidance.mcp.user-config', { agent: input.agent }),
    troubleshooting: input.troubleshooting,
  });
}

function projectMcpEntry(input: {
  agent: EditorId;
  fileOwner?: EditorId;
  sharedWith?: AgentId[];
  consentClass: ConsentClass;
  strictness: EntryStrictness;
  attestation: Attestation;
  troubleshooting?: GuidanceRef;
}): SatisfierRecord {
  return defineSatisfier({
    agent: input.agent,
    piece: 'mcp',
    scope: 'project',
    kind: 'config-entry',
    pathId: editorPathId('editor-project-config', input.fileOwner ?? input.agent),
    sharedWith: input.sharedWith,
    consentClass: input.consentClass,
    probe: probeable(...input.strictness),
    attestation: input.attestation,
    audience: 'this-project',
    guidance: guide('guidance.mcp.project-config', { agent: input.agent }),
    followup: followupFor(input.consentClass, input.agent),
    troubleshooting: input.troubleshooting,
  });
}

function projectSkill(input: {
  agent: EditorId;
  prerequisites: SatisfierId[];
  attestation: Attestation;
  troubleshooting?: GuidanceRef;
}): SatisfierRecord {
  return defineSatisfier({
    agent: input.agent,
    piece: 'skill',
    scope: 'project',
    kind: 'skill-bundle-copy',
    pathId: editorPathId('editor-project-skill-root', input.agent),
    prerequisites: input.prerequisites,
    probe: probeable('reclaim-permissive'),
    attestation: input.attestation,
    audience: 'this-project',
    guidance: guide('guidance.skill.project', { agent: input.agent }),
    troubleshooting: input.troubleshooting,
  });
}

function userSkill(input: { agent: EditorId; attestation: Attestation }): SatisfierRecord {
  return defineSatisfier({
    agent: input.agent,
    piece: 'skill',
    scope: 'user',
    kind: 'skill-bundle-copy',
    pathId: editorPathId('editor-user-skill-root', input.agent),
    probe: probeable('reclaim-permissive'),
    attestation: input.attestation,
    audience: 'this-user',
    guidance: guide('guidance.skill.user', { agent: input.agent }),
  });
}

function sessionInjection(agent: AgentId): SatisfierRecord {
  return defineSatisfier({
    agent,
    piece: 'mcp',
    scope: 'session',
    kind: 'session-injection',
    probe: unprobeable('session-scoped'),
    attestation: attestVerified([
      read(CODE.threadManager, 'the session MCP config the thread manager builds per thread'),
    ]),
    audience: 'this-project',
    installability: 'not-installable',
    notInstallableReason: 'session-scoped',
    guidance: guide('guidance.mcp.session-injection', { agent }),
  });
}

const claude = defineAgent({
  id: 'claude',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.claude,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:claude', 'scheme-handler:claude-code'],
  satisfiers: [
    userMcpEntry({
      agent: 'claude',
      strictness: ['reclaim-permissive', 'pre-approval-exact', 'injection-functional'],
      attestation: attestVerified([read(CODE.cliEditors, 'user-global MCP config target')]),
    }),
    projectMcpEntry({
      agent: 'claude',
      sharedWith: ['copilot'],
      consentClass: 'approve-once',
      strictness: ['reclaim-permissive', 'pre-approval-exact', 'injection-functional'],
      attestation: attestVerified([read(CODE.cliEditors), read(CODE.coreEditors)]),
      troubleshooting: guide('troubleshooting.claude.project-entry-not-approved', {
        agent: 'claude',
      }),
    }),
    projectSkill({
      agent: 'claude',
      prerequisites: [sid('claude', 'mcp', 'project', 'config-entry')],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.repairSkills)]),
    }),
    userSkill({
      agent: 'claude',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
    sessionInjection('claude'),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([
          sid('claude', 'mcp', 'user', 'config-entry'),
          sid('claude', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('claude', 'skill', 'project', 'skill-bundle-copy'),
          sid('claude', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([
          sid('claude', 'mcp', 'user', 'config-entry'),
          sid('claude', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('claude', 'skill', 'project', 'skill-bundle-copy'),
          sid('claude', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([
          sid('claude', 'mcp', 'session', 'session-injection'),
          sid('claude', 'mcp', 'user', 'config-entry'),
          sid('claude', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('claude', 'skill', 'project', 'skill-bundle-copy'),
          sid('claude', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'claude-acp',
    featuredOrder: 0,
    harnessCli: 'claude',
    readsEditorConfig: 'claude',
    readsEditorConfigAttestation: attestVerified(
      [
        read(
          CODE.threadManager,
          'the injection-skip probe reads the managed entry for this editor',
        ),
        observed(
          'claude-acp adapter',
          'The adapter runs Claude Code, which loads the MCP entry OK writes for the Claude editor on its own, so injecting a same-name duplicate would be redundant.',
        ),
      ],
      CATALOG_PIN,
    ),
    verifiedPosture: 'asks',
  }),
  external: externalFacet({
    targetId: 'claude-code',
    knownOrder: 1,
    visible: true,
    displayName: 'Claude',
    appBrandName: 'Claude Desktop',
    schemes: ['claude:'],
    installUrl: 'https://claude.com/download',
    tagline: "Agentic coding in Claude Desktop's Code tab.",
  }),
});

const claudeDesktop = defineAgent({
  id: 'claude-desktop',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG['claude-desktop'],
  offersConnectionRow: false,
  detectionSources: ['scheme-handler:claude-code'],
  satisfiers: [
    userMcpEntry({
      agent: 'claude-desktop',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([
        read(CODE.cliEditors, 'user-global config target; its path resolution throws on Linux'),
      ]),
      troubleshooting: guide('troubleshooting.claude-desktop.per-tool-approval', {
        agent: 'claude-desktop',
      }),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('claude-desktop', 'mcp', 'user', 'config-entry')]),
        skillRequirement([]),
      ],
    },
  },
  external: externalFacet({
    targetId: 'claude-cowork',
    knownOrder: 0,
    visible: false,
    displayName: 'Claude Cowork',
    appBrandName: 'Claude Desktop',
    schemes: ['claude:'],
    installUrl: 'https://claude.com/download',
    tagline: "Conversational pairing in Claude Desktop's Cowork tab.",
  }),
});

const cursor = defineAgent({
  id: 'cursor',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.cursor,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:cursor', 'scheme-handler:cursor'],
  satisfiers: [
    userMcpEntry({
      agent: 'cursor',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([read(CODE.cliEditors)]),
    }),
    projectMcpEntry({
      agent: 'cursor',
      consentClass: 'enable-manually',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([read(CODE.cliEditors), read(CODE.coreEditors)]),
      troubleshooting: guide('troubleshooting.cursor.project-entry-not-loaded', {
        agent: 'cursor',
      }),
    }),
    projectSkill({
      agent: 'cursor',
      prerequisites: [sid('cursor', 'mcp', 'project', 'config-entry')],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.repairSkills)]),
    }),
    userSkill({
      agent: 'cursor',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
    sessionInjection('cursor'),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([
          sid('cursor', 'mcp', 'user', 'config-entry'),
          sid('cursor', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('cursor', 'skill', 'project', 'skill-bundle-copy'),
          sid('cursor', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([
          sid('cursor', 'mcp', 'user', 'config-entry'),
          sid('cursor', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('cursor', 'skill', 'project', 'skill-bundle-copy'),
          sid('cursor', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([sid('cursor', 'mcp', 'session', 'session-injection')]),
        skillRequirement([
          sid('cursor', 'skill', 'project', 'skill-bundle-copy'),
          sid('cursor', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'cursor',
    featuredOrder: 3,
    harnessCli: 'cursor',
    readsEditorConfig: null,
    readsEditorConfigAttestation: attestVerified(
      [
        observed(
          'cursor-agent mcp list',
          'Reports a config-declared entry that has not been approved as "not loaded (needs approval)", so a present entry says nothing about whether the agent will have the tools.',
        ),
        read(CODE.threadManager, 'the one agent the skip probe never stands down for'),
      ],
      { observedAt: '2026-08-20' },
    ),
    verifiedPosture: 'self-managed',
  }),
  external: externalFacet({
    targetId: 'cursor',
    knownOrder: 3,
    visible: true,
    displayName: 'Cursor',
    schemes: ['cursor:'],
    installUrl: 'https://cursor.com/',
    tagline: 'AI-first VS Code fork with multi-file edits.',
  }),
});

const codex = defineAgent({
  id: 'codex',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.codex,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:codex', 'scheme-handler:codex'],
  satisfiers: [
    userMcpEntry({
      agent: 'codex',
      strictness: ['reclaim-permissive', 'injection-functional'],
      attestation: attestVerified([read(CODE.cliEditors, 'TOML user-global config target')]),
    }),
    projectMcpEntry({
      agent: 'codex',
      consentClass: 'trust-gated',
      strictness: ['reclaim-permissive', 'injection-functional'],
      attestation: attestContested(
        [
          read(CODE.cliEditors, 'project config path added by analogy with the other editors'),
          {
            kind: 'upstream-issue',
            ref: 'openai/codex#13025',
            note: 'open, reproduced on builds newer than the one OK checked',
          },
          {
            kind: 'observation',
            ref: 'codex-desktop-project-config-load',
            note: 'single non-repro on 26.623.81905; the CLI honors it only for a trusted project',
          },
        ],
        { version: '26.707.72221', observedAt: '2026-07-15' },
      ),
      troubleshooting: guide('troubleshooting.codex.desktop-project-config', {
        agent: 'codex',
        honoredByDesktop: false,
      }),
    }),
    projectSkill({
      agent: 'codex',
      prerequisites: [sid('codex', 'mcp', 'project', 'config-entry')],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.repairSkills)]),
    }),
    userSkill({
      agent: 'codex',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
    sessionInjection('codex'),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([
          sid('codex', 'mcp', 'user', 'config-entry'),
          sid('codex', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('codex', 'skill', 'project', 'skill-bundle-copy'),
          sid('codex', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([
          sid('codex', 'mcp', 'user', 'config-entry'),
          sid('codex', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('codex', 'skill', 'project', 'skill-bundle-copy'),
          sid('codex', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([
          sid('codex', 'mcp', 'session', 'session-injection'),
          sid('codex', 'mcp', 'user', 'config-entry'),
          sid('codex', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('codex', 'skill', 'project', 'skill-bundle-copy'),
          sid('codex', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'codex-acp',
    featuredOrder: 1,
    harnessCli: 'codex',
    readsEditorConfig: 'codex',
    readsEditorConfigAttestation: attestVerified(
      [
        read(CODE.cliEditors, 'the managed MCP entry OK writes into the Codex TOML config'),
        observed(
          'codex-acp adapter',
          'The adapter runs the Codex CLI, which loads the MCP servers declared in its own config, so the managed entry is already in the session.',
        ),
      ],
      CATALOG_PIN,
    ),
    verifiedPosture: 'self-managed',
  }),
  external: externalFacet({
    targetId: 'codex',
    knownOrder: 2,
    visible: true,
    displayName: 'ChatGPT',
    appBrandName: 'ChatGPT Desktop',
    schemes: ['codex:'],
    installUrl: 'https://developers.openai.com/codex/app',
    tagline: "OpenAI's ChatGPT desktop app, home of the Codex agent.",
  }),
});

const copilot = defineAgent({
  id: 'copilot',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.copilot,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:copilot'],
  satisfiers: [
    userMcpEntry({
      agent: 'copilot',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([read(CODE.cliEditors)]),
    }),
    projectMcpEntry({
      agent: 'copilot',
      fileOwner: 'claude',
      sharedWith: ['claude'],
      consentClass: 'trust-gated',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified(
        [
          {
            kind: 'vendor-doc',
            ref: 'GitHub Copilot CLI — MCP configuration',
            note: 'reads workspace `.mcp.json` or `.github/mcp.json`',
          },
          read(CODE.coreEditors, 'OK deliberately writes no second copy for copilot'),
        ],
        { version: 'copilot CLI 1.0.80', observedAt: '2026-08-20' },
      ),
      troubleshooting: guide('troubleshooting.copilot.shared-workspace-config', {
        agent: 'copilot',
        sourceAgent: 'claude',
      }),
    }),
    projectSkill({
      agent: 'copilot',
      prerequisites: [
        sid('copilot', 'mcp', 'project', 'config-entry'),
        sid('copilot', 'mcp', 'user', 'config-entry'),
      ],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.writeProjectSkill)]),
    }),
    userSkill({
      agent: 'copilot',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
    sessionInjection('copilot'),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([
          sid('copilot', 'mcp', 'user', 'config-entry'),
          sid('copilot', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('copilot', 'skill', 'project', 'skill-bundle-copy'),
          sid('copilot', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([
          sid('copilot', 'mcp', 'user', 'config-entry'),
          sid('copilot', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('copilot', 'skill', 'project', 'skill-bundle-copy'),
          sid('copilot', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([sid('copilot', 'mcp', 'session', 'session-injection')]),
        skillRequirement([
          sid('copilot', 'skill', 'project', 'skill-bundle-copy'),
          sid('copilot', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'github-copilot-cli',
    featuredOrder: 4,
    harnessCli: null,
    readsEditorConfig: null,
    readsEditorConfigAttestation: {
      confidence: 'assumed',
      evidence: [
        observed(
          'copilot CLI 1.0.80',
          'The CLI does read a workspace `.mcp.json`, but nobody has observed the ACP adapter loading the managed entry inside a session. Claiming it would stand our injection down on an unverified read and risk a thread with no OK tools, so the claim stays unmade and OK keeps injecting.',
        ),
      ],
      verifiedAgainst: { version: '1.0.80', observedAt: '2026-08-20' },
    },
    verifiedPosture: null,
  }),
  external: externalFacet({
    targetId: 'copilot',
    knownOrder: 4,
    visible: false,
    displayName: 'GitHub Copilot',
    schemes: [],
    installUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    tagline: "GitHub's terminal-native coding agent.",
  }),
});

const opencode = defineAgent({
  id: 'opencode',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.opencode,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:opencode'],
  satisfiers: [
    userMcpEntry({
      agent: 'opencode',
      strictness: ['reclaim-permissive', 'injection-functional'],
      attestation: attestVerified([
        read(CODE.cliEditors, 'XDG config dir; the win32 location is by analogy and unverified'),
      ]),
    }),
    projectMcpEntry({
      agent: 'opencode',
      consentClass: 'none',
      strictness: ['reclaim-permissive', 'injection-functional'],
      attestation: attestVerified([
        read(CODE.cliEditors, 'the one project config that is not under a dotdir'),
      ]),
    }),
    projectSkill({
      agent: 'opencode',
      prerequisites: [sid('opencode', 'mcp', 'project', 'config-entry')],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.repairSkills)]),
    }),
    userSkill({
      agent: 'opencode',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
    sessionInjection('opencode'),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([
          sid('opencode', 'mcp', 'user', 'config-entry'),
          sid('opencode', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('opencode', 'skill', 'project', 'skill-bundle-copy'),
          sid('opencode', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([
          sid('opencode', 'mcp', 'user', 'config-entry'),
          sid('opencode', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('opencode', 'skill', 'project', 'skill-bundle-copy'),
          sid('opencode', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([
          sid('opencode', 'mcp', 'session', 'session-injection'),
          sid('opencode', 'mcp', 'user', 'config-entry'),
          sid('opencode', 'mcp', 'project', 'config-entry'),
        ]),
        skillRequirement([
          sid('opencode', 'skill', 'project', 'skill-bundle-copy'),
          sid('opencode', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'opencode',
    featuredOrder: 5,
    harnessCli: 'opencode',
    readsEditorConfig: 'opencode',
    readsEditorConfigAttestation: attestVerified(
      [
        read(CODE.cliEditors, 'the managed MCP entry OK writes into the opencode config'),
        observed(
          'opencode-acp adapter',
          'The adapter runs opencode, which loads its own configured MCP servers, so the managed entry is already in the session.',
        ),
      ],
      CATALOG_PIN,
    ),
    verifiedPosture: null,
  }),
  external: externalFacet({
    targetId: 'opencode',
    knownOrder: 5,
    visible: false,
    displayName: 'OpenCode',
    schemes: [],
    installUrl: 'https://opencode.ai',
    tagline: 'Open-source terminal coding agent; bring any local model.',
  }),
});

const openclaw = defineAgent({
  id: 'openclaw',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.openclaw,
  offersConnectionRow: true,
  offerOnlyWhenDetected: true,
  detectionSources: ['cli-on-path:openclaw'],
  satisfiers: [
    userMcpEntry({
      agent: 'openclaw',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([
        read(CODE.cliEditors, 'the one two-level server map, nested under `mcp.servers`'),
      ]),
    }),
    defineSatisfier({
      agent: 'openclaw',
      piece: 'skill',
      scope: 'user',
      kind: 'central-store-copy',
      pathId: CENTRAL_SKILL_STORE_PATH_ID,
      probe: probeable('reclaim-permissive'),
      attestation: attestVerified([
        read(CODE.coreEditors),
        read(CODE.skillInstall, 'the hub is written only when it already exists'),
      ]),
      audience: 'this-user',
      guidance: guide('guidance.skill.central-store', { agent: 'openclaw' }),
      troubleshooting: guide('troubleshooting.openclaw.central-store-missing', {
        agent: 'openclaw',
      }),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('openclaw', 'mcp', 'user', 'config-entry')]),
        skillRequirement([sid('openclaw', 'skill', 'user', 'central-store-copy')]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([sid('openclaw', 'mcp', 'user', 'config-entry')]),
        skillRequirement([sid('openclaw', 'skill', 'user', 'central-store-copy')]),
      ],
    },
  },
  external: externalFacet({
    targetId: 'openclaw',
    knownOrder: 8,
    visible: false,
    displayName: 'OpenClaw',
    schemes: [],
    installUrl: 'https://openclaw.ai',
    tagline: 'Open-source agent gateway; runs agents against your MCP servers.',
  }),
});

const pi = defineAgent({
  id: 'pi',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.pi,
  offersConnectionRow: true,
  detectionSources: ['cli-on-path:pi'],
  satisfiers: [
    defineSatisfier({
      agent: 'pi',
      piece: 'mcp',
      scope: 'project',
      kind: 'managed-file',
      pathId: editorPathId('editor-project-config', 'pi'),
      probe: probeable('reclaim-permissive', 'injection-functional'),
      attestation: attestVerified([
        read(CODE.cliEditors, 'OK owns the whole file; currency is a first-line sentinel'),
        read(CODE.acpRegistry, 'the thread provisions this file instead of injecting'),
      ]),
      audience: 'this-project',
      guidance: guide('guidance.mcp.managed-file', { agent: 'pi' }),
      troubleshooting: guide('troubleshooting.pi.folder-trust', { agent: 'pi' }),
    }),
    projectSkill({
      agent: 'pi',
      prerequisites: [sid('pi', 'mcp', 'project', 'managed-file')],
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.writeProjectSkill)]),
      troubleshooting: guide('troubleshooting.pi.folder-trust', { agent: 'pi' }),
    }),
    userSkill({
      agent: 'pi',
      attestation: attestVerified([
        read(CODE.coreEditors, 'the agent home nests one level below the dotdir'),
        read(CODE.skillInstall),
      ]),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('pi', 'mcp', 'project', 'managed-file')]),
        skillRequirement([
          sid('pi', 'skill', 'project', 'skill-bundle-copy'),
          sid('pi', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([sid('pi', 'mcp', 'project', 'managed-file')]),
        skillRequirement([
          sid('pi', 'skill', 'project', 'skill-bundle-copy'),
          sid('pi', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
    acp: {
      requirements: [
        mcpRequirement([sid('pi', 'mcp', 'project', 'managed-file')]),
        skillRequirement([
          sid('pi', 'skill', 'project', 'skill-bundle-copy'),
          sid('pi', 'skill', 'user', 'skill-bundle-copy'),
        ]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'pi-acp',
    featuredOrder: null,
    harnessCli: 'pi',
    readsEditorConfig: 'pi',
    readsEditorConfigAttestation: attestVerified(
      [
        observed(
          'pi-acp@0.0.33',
          'Pi has no MCP client at all: it accepts `mcpServers` at session/new, stores them write-only and never connects. Its wiring is a managed extension FILE in the project, which OK provisions instead of injecting — the same mapping, a different shape.',
        ),
        read(
          CODE.threadManager,
          'the bridge route that provisions the extension instead of injecting',
        ),
      ],
      { version: '0.0.33', observedAt: '2026-08-20' },
    ),
    verifiedPosture: 'autonomous',
  }),
  external: externalFacet({
    targetId: 'pi',
    knownOrder: 6,
    visible: false,
    displayName: 'Pi',
    schemes: [],
    installUrl: 'https://pi.dev',
    tagline: 'Minimal open-source terminal coding agent, extensible in TypeScript.',
  }),
});

const antigravity = defineAgent({
  id: 'antigravity',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.antigravity,
  offersConnectionRow: true,
  offerOnlyWhenDetected: true,
  detectionSources: ['cli-on-path:antigravity'],
  satisfiers: [
    userMcpEntry({
      agent: 'antigravity',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([
        read(
          CODE.cliEditors,
          'one user-global file shared by the IDE, the app and the CLI; per project you can only filter it',
        ),
      ]),
    }),
    userSkill({
      agent: 'antigravity',
      attestation: attestVerified([read(CODE.coreEditors), read(CODE.skillInstall)]),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('antigravity', 'mcp', 'user', 'config-entry')]),
        skillRequirement([sid('antigravity', 'skill', 'user', 'skill-bundle-copy')]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([sid('antigravity', 'mcp', 'user', 'config-entry')]),
        skillRequirement([sid('antigravity', 'skill', 'user', 'skill-bundle-copy')]),
      ],
    },
  },
  external: externalFacet({
    targetId: 'antigravity',
    knownOrder: 7,
    visible: false,
    displayName: 'Antigravity',
    schemes: [],
    installUrl: 'https://antigravity.google',
    tagline: "Google's agentic IDE + `agy` terminal agent.",
  }),
});

const lmStudio = defineAgent({
  id: 'lm-studio',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG['lm-studio'],
  offersConnectionRow: true,
  offerOnlyWhenDetected: true,
  detectionSources: [],
  satisfiers: [
    userMcpEntry({
      agent: 'lm-studio',
      strictness: ['reclaim-permissive'],
      installability: 'not-installable',
      notInstallableReason: 'no-non-interactive-verb',
      attestation: attestVerified([
        read(CODE.cliEditors, 'two candidate locations, resolved against what already exists'),
        {
          kind: 'upstream-issue',
          ref: 'lmstudio-ai/lmstudio-bug-tracker#1371',
          note: 'documented config path differs from the one the app reads on macOS',
        },
        read(CODE.presenceProbes, 'deliberately absent from the presence probes'),
      ]),
      troubleshooting: guide('troubleshooting.lm-studio.config-path-mismatch', {
        agent: 'lm-studio',
      }),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('lm-studio', 'mcp', 'user', 'config-entry')]),
        skillRequirement([]),
      ],
    },
  },
});

const hermes = defineAgent({
  id: 'hermes',
  setupDocSlug: EDITOR_SETUP_DOC_SLUG.hermes,
  offersConnectionRow: true,
  offerOnlyWhenDetected: true,
  detectionSources: ['cli-on-path:hermes'],
  satisfiers: [
    userMcpEntry({
      agent: 'hermes',
      strictness: ['reclaim-permissive'],
      attestation: attestVerified([
        read(CODE.cliEditors, 'the one YAML target; the whole config is a single user-global file'),
      ]),
    }),
  ],
  modes: {
    external: {
      requirements: [
        mcpRequirement([sid('hermes', 'mcp', 'user', 'config-entry')]),
        skillRequirement([]),
      ],
    },
    terminal: {
      requirements: [
        mcpRequirement([sid('hermes', 'mcp', 'user', 'config-entry')]),
        skillRequirement([]),
      ],
    },
  },
  external: externalFacet({
    targetId: 'hermes',
    knownOrder: 9,
    visible: false,
    displayName: 'Hermes',
    schemes: [],
    installUrl: 'https://hermes-agent.nousresearch.com',
    tagline: "Nous Research's terminal coding agent.",
  }),
});

const gemini = defineAgent({
  id: 'gemini',
  setupDocSlug: null,
  detectionSources: ['harness-bin:gemini'],
  satisfiers: [sessionInjection('gemini')],
  modes: {
    acp: {
      requirements: [
        mcpRequirement([sid('gemini', 'mcp', 'session', 'session-injection')]),
        skillRequirement([]),
      ],
    },
  },
  acp: acpFacet({
    acpAgentId: 'gemini',
    featuredOrder: 2,
    harnessCli: 'gemini',
    readsEditorConfig: null,
    readsEditorConfigAttestation: attestVerified(
      [
        read(
          CODE.coreEditors,
          'gemini reaches OK as an ACP agent only; it has no editor config target',
        ),
      ],
      CATALOG_PIN,
    ),
    verifiedPosture: null,
  }),
});

export const AGENT_REGISTRY: Readonly<Record<AgentId, AgentRecord>> = {
  claude,
  'claude-desktop': claudeDesktop,
  cursor,
  codex,
  copilot,
  opencode,
  openclaw,
  pi,
  antigravity,
  'lm-studio': lmStudio,
  hermes,
  gemini,
};

export function getAgentRecord(id: string): AgentRecord | undefined {
  return (AGENT_REGISTRY as Record<string, AgentRecord | undefined>)[id];
}

export const ALL_SATISFIERS: readonly SatisfierRecord[] = Object.values(AGENT_REGISTRY).flatMap(
  (agent) => agent.satisfiers,
);

const SATISFIERS_BY_ID = new Map<string, SatisfierRecord>(
  ALL_SATISFIERS.map((satisfier) => [satisfier.id, satisfier]),
);

export function getSatisfierRecord(id: string): SatisfierRecord | undefined {
  return SATISFIERS_BY_ID.get(id);
}
