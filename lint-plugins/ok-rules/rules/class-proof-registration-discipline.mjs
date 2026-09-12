import { docsUrl } from '../docs.mjs';

const URL = docsUrl('class-proof-registration-discipline');

const OPTIONS_MESSAGE = `Class-proof registration missing \`predicate\` or \`proof\` option — both are required by \`ClassProofOptions<M>\`. Provide all three of \`{ enumerate, predicate, proof }\` to \`defineClassProof()\`. See ${URL}`;
const LOCATION_MESSAGE = `Class-proof registered outside the canonical dir. Move the \`defineClassProof(...)\` call to \`packages/md-conformance/src/class-proofs/proofs/<name>.ts\` and export it from \`run-all.ts\` so it participates in the orchestrator manifest. See ${URL}`;

const HAS_PREDICATE = /\bpredicate\s*:/;
const HAS_PROOF = /\bproof\s*:/;

export const classProofRegistrationDiscipline = {
  meta: {
    type: 'problem',
    docs: {
      description: 'defineClassProof registrations must be complete and live in the canonical dir.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || node.callee.name !== 'defineClassProof') return;
        const args = node.arguments ?? [];
        if (args.length < 2) return;
        const options = source.getText(args[1]);
        if (!HAS_PREDICATE.test(options) || !HAS_PROOF.test(options)) {
          context.report({ node, message: OPTIONS_MESSAGE });
          return;
        }
        context.report({ node, message: LOCATION_MESSAGE });
      },
    };
  },
};
