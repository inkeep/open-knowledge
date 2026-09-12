import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-blind-agent-host-fanout');

const MESSAGE = `User-global skill installs must be gated on detected hosts, not fanned out via the \`skills\` CLI's \`--agent '*'\`. OK writes these dirs itself — use \`installUserSkill\` / \`detectUserSkillHosts\` from @inkeep/open-knowledge-server, whose host set comes from core's \`HOSTS_WITH_USER_SKILL_DIR\`. \`--agent '*'\` bypasses host detection and creates config dirs for tools the user never installed (issue #820: 51 such dirs from one \`ok init\`). See ${URL}`;

export const FORBIDDEN_SPECS = [
  'skills@~1.5.0',
  'skills@^1.5.0',
  'skills@1.5.0',
  'skills@latest',
  '--agent',
];

const FORBIDDEN = new Set(FORBIDDEN_SPECS);

export const noBlindAgentHostFanout = {
  meta: {
    type: 'problem',
    docs: {
      description: 'User-global skill installs must be gated on detected hosts.',
      url: URL,
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !FORBIDDEN.has(node.value)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
