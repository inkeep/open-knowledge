// Contributor-CLA gate for the public-PR bridge.
//
// cla-assistant posts a `license/cla` commit status on the PUBLIC pull request.
// The bridge re-commits that PR into agents-private under a fresh SHA, so the
// public status cannot serve as a required check on the internal PR. This module
// turns the public signal into a hold/release decision the bridge enforces by
// holding the internal PR as a draft plus a `cla/verified` status until signed.
//
// Exemption is derived, not listed: Inkeep employees are released by live
// `inkeep` org membership (resolved in `applyClaGate` through the injected
// adapter), so there is no employee roster to keep in sync with the team. Only
// the bots that open or sync PRs — which can't sign and aren't org members —
// stay explicit here.
//
// Fail-closed: only a confirmed signature (`license/cla` === "success"), org
// membership, or a listed bot releases the hold. A missing, pending, failing, or
// errored status — or a membership/status read that threw — holds the PR.

// Bot actors that open or sync PRs and cannot sign a CLA. Humans are NOT listed
// here — their exemption comes from live org membership. Keep this in sync with
// the bots whitelisted on the cla-assistant dashboard.
export const BOT_ALLOWLIST = [
  "inkeep-oss-sync[bot]",
  "inkeep-internal-ci[bot]",
  "copilot-swe-agent[bot]",
];

// GitHub logins are case-insensitive.
export function isBot(login, bots = BOT_ALLOWLIST) {
  if (!login) return false;
  const lower = login.toLowerCase();
  return bots.some((entry) => entry.toLowerCase() === lower);
}

/**
 * Decide whether the bridged internal PR must be held for an unsigned CLA, given
 * an already-resolved exemption (the author is a listed bot or an org member).
 *
 * @param {object} input
 * @param {string|null|undefined} input.claStatus `license/cla` combined-status state
 *   ("success" | "pending" | "failure" | "error"), or null/undefined when absent.
 * @param {boolean} [input.exempt] True when the author is exempt from signing.
 * @returns {{ gated: boolean, reason: "exempt" | "cla-signed" | "cla-unsigned" | "cla-errored" | "cla-pending" }}
 */
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
  // `error` is the check itself erroring (cla-assistant infra), distinct from a
  // contributor not signing — cla-assistant reports unsigned as `pending`. Both
  // hold the PR, but the surfaced message must not tell a signed contributor to
  // "sign the CLA" during an outage.
  if (claStatus === "error") {
    return { gated: true, reason: "cla-errored" };
  }
  return { gated: true, reason: "cla-pending" };
}

// Human-readable description attached to the `cla/verified` commit status.
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

/**
 * Enforce the CLA gate on a bridged internal PR: resolve the author's exemption
 * (a listed bot, or a live `inkeep` org member), and for everyone else read the
 * public PR's `license/cla` status — then hold the internal PR (draft plus a
 * failing `cla/verified` status) until the contributor has signed. Runs on every
 * bridge sync, so a later unsigned head re-blocks a previously-released PR.
 *
 * Fail-closed: if the membership or status read throws, the PR is held. The
 * draft/status writes are intentionally outside the catch — if those fail, the
 * bridge should surface the error rather than silently leave the PR in an
 * unknown state.
 *
 * @param {object} input
 * @param {object} input.gh  Injected GitHub adapter (the bridge supplies the real
 *   one; tests supply a fake):
 *   - isOrgMember(login) => Promise<boolean>  true when the login is an Inkeep org member
 *   - readClaStatus(publicPr) => Promise<string|null>  the `license/cla` state
 *   - setDraft(internalPr, shouldBeDraft) => Promise<void>
 *   - setVerifiedStatus(internalPr, state, description) => Promise<void>  posts `cla/verified`
 * @param {object} input.publicPr    Public PR: { user: { login }, draft, head: { sha } }.
 * @param {object} input.internalPr  Internal PR: { head: { sha } }.
 * @param {boolean} [input.forceDraft]  When true, hold the PR as a draft regardless
 *   of CLA/origin draft state — used when the bridged commit carries conflict
 *   markers that a maintainer must resolve before the PR can merge.
 * @returns {Promise<{ gated: boolean, reason: string }>} reason is one of
 *   evaluateClaGate's reasons, or "cla-read-error" when a read threw.
 */
export async function applyClaGate({ gh, publicPr, internalPr, forceDraft = false }) {
  const author = publicPr?.user?.login;
  let gate;
  try {
    let exempt = isBot(author);
    if (!exempt && author) {
      exempt = await gh.isOrgMember(author);
    }
    // An exempt author never needs the public CLA status, so skip the read.
    const claStatus = exempt ? null : await gh.readClaStatus(publicPr);
    gate = evaluateClaGate({ claStatus, exempt });
  } catch (error) {
    // Fail closed for the security gate, but surface WHY the read failed
    // (401 / rate limit / API down) so a perpetual cla-read-error hold is
    // triagable.
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
