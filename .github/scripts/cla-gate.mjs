export const BOT_ALLOWLIST = [
  "inkeep-oss-sync[bot]",
  "inkeep-internal-ci[bot]",
  "copilot-swe-agent[bot]",
];

export function isBot(login, bots = BOT_ALLOWLIST) {
  if (!login) return false;
  const lower = login.toLowerCase();
  return bots.some((entry) => entry.toLowerCase() === lower);
}

export function evaluateClaGate({ claStatus, exempt = false }) {
  if (exempt) {
    return { gated: false, reason: "exempt" };
  }
  if (claStatus === "success") {
    return { gated: false, reason: "cla-signed" };
  }
  if (claStatus === "failure") {
    return { gated: true, reason: "cla-unsigned" };
  }
  if (claStatus === "error") {
    return { gated: true, reason: "cla-errored" };
  }
  return { gated: true, reason: "cla-pending" };
}

function describeReason(reason) {
  switch (reason) {
    case "cla-signed":
      return "CLA signed.";
    case "exempt":
      return "Author is an Inkeep org member or an allowlisted bot; no CLA required.";
    case "cla-unsigned":
      return "CLA not signed. Sign the CLA on the public pull request.";
    case "cla-errored":
      return "CLA check errored on the public pull request; holding until it can be confirmed.";
    case "cla-read-error":
      return "Could not verify CLA status; holding the PR until it can be confirmed.";
    default:
      return "Awaiting CLA signature on the public pull request.";
  }
}

export async function applyClaGate({ gh, publicPr, internalPr, forceDraft = false }) {
  const author = publicPr?.user?.login;
  let gate;
  try {
    let exempt = isBot(author);
    if (!exempt && author) {
      exempt = await gh.isOrgMember(author);
    }
    const claStatus = exempt ? null : await gh.readClaStatus(publicPr);
    gate = evaluateClaGate({ claStatus, exempt });
  } catch (error) {
    console.warn(`Bridge: CLA gate read failed for ${author}: ${error.message}`);
    gate = { gated: true, reason: "cla-read-error" };
  }

  const shouldBeDraft = Boolean(publicPr?.draft) || gate.gated || forceDraft;
  await gh.setDraft(internalPr, shouldBeDraft);
  await gh.setVerifiedStatus(
    internalPr,
    gate.gated ? "failure" : "success",
    describeReason(gate.reason),
  );
  return gate;
}
